// coresim-capture
// =============================================================================
// Direct CoreSimulator framebuffer capture for iOS Simulators, encoded with
// VideoToolbox to Baseline H.264 Annex-B. No ScreenCaptureKit, no CGDisplay,
// no AVFoundation screen recording, no window capture, no FFmpeg.
//
// Pipeline:
//   SimDisplayIOSurfaceRenderable.ioSurface  (IOSurface, device pixels)
//     → CVPixelBuffer (zero-copy, CVPixelBufferCreateWithIOSurface)
//     → VTCompressionSession (Baseline, RealTime, no reordering, periodic IDR)
//     → Annex-B access units
//
// Process contract (consumed by the Node CoreSimIOSurfaceStream wrapper):
//   stdout : repeated [uint32 BE length][Annex-B access-unit bytes]
//            CONFIG (SPS+PPS) is prepended in-band before each IDR.
//   stderr : line-delimited text.
//              "GEOMETRY {json}"  → CaptureGeometry inputs (device px, scale, fps)
//              "READY"            → first encoded frame emitted
//              "LOG ..."          → diagnostics
//              "FATAL ..."        → unrecoverable; process will exit non-zero
//   stdin  : single bytes. 'K' = force an IDR on the next frame (renegotiation).
//
// IMPORTANT (private API): CoreSimulator is a private framework. Selector and
// class names below match Xcode 14–16 and are resolved dynamically at runtime
// so a missing symbol fails loudly (FATAL) instead of crashing. Validate with
// `class-dump` against the target Xcode if a future release breaks resolution
// (risk E1). The Node side treats a non-zero exit as "fall back to transcode".
// =============================================================================

import Foundation
import CoreVideo
import VideoToolbox
import IOSurface

// MARK: - stderr / stdout helpers

let stderrHandle = FileHandle.standardError
let stdoutHandle = FileHandle.standardOutput

func emitLine(_ s: String) {
    if let d = (s + "\n").data(using: .utf8) { stderrHandle.write(d) }
}
func log(_ s: String) { emitLine("LOG \(s)") }
func fatal(_ s: String) -> Never {
    emitLine("FATAL \(s)")
    exit(2)
}

// Length-prefixed binary frame on stdout. Single writer thread via a queue.
let outputQueue = DispatchQueue(label: "coresim.output")
func emitAccessUnit(_ data: Data) {
    outputQueue.async {
        var len = UInt32(data.count).bigEndian
        var header = Data(bytes: &len, count: 4)
        header.append(data)
        stdoutHandle.write(header)
    }
}

// MARK: - Argument parsing

struct Args {
    var udid: String = ""
    var fps: Int = 30
    var bitrate: Int = 6_000_000
    var keyframeIntervalSec: Double = 2.0
    var developerDir: String? = nil
    var probeOnly: Bool = false
    var dump: Bool = false
}

func parseArgs() -> Args {
    var a = Args()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = it.next() {
        switch arg {
        case "--udid": a.udid = it.next() ?? ""
        case "--fps": a.fps = Int(it.next() ?? "") ?? a.fps
        case "--bitrate": a.bitrate = Int(it.next() ?? "") ?? a.bitrate
        case "--keyframe-interval": a.keyframeIntervalSec = Double(it.next() ?? "") ?? a.keyframeIntervalSec
        case "--developer-dir": a.developerDir = it.next()
        case "--probe": a.probeOnly = true
        case "--dump": a.dump = true
        default: log("ignoring unknown arg \(arg)")
        }
    }
    return a
}

// MARK: - Objective-C dynamic call helpers (private framework safe)

func loadCoreSimulator() {
    // Resolve from the active developer dir so it matches the simulator runtime.
    let devDir = (ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? runXcodeSelect()) ?? "/Applications/Xcode.app/Contents/Developer"

    // On modern macOS/Xcode the CoreSimulator framework is installed system-wide
    // under /Library/Developer/PrivateFrameworks, not inside Xcode.app. Try the
    // system-wide copy first, then the in-Xcode location for older toolchains.
    var candidates: [String] = []
    if let override = ProcessInfo.processInfo.environment["CORESIM_FRAMEWORK_PATH"], !override.isEmpty {
        candidates.append(override)
    }
    candidates.append("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")
    candidates.append("\(devDir)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator")

    var lastErr = "no candidate paths"
    for path in candidates {
        if dlopen(path, RTLD_NOW) != nil { return }
        lastErr = "\(path): \(String(cString: dlerror()))"
    }

    // Fall back to letting the dynamic loader find an already-registered copy.
    if NSClassFromString("SimServiceContext") == nil {
        fatal("could not dlopen CoreSimulator (tried \(candidates.count) paths) — last error: \(lastErr)")
    }
}

func runXcodeSelect() -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    p.arguments = ["-p"]
    let pipe = Pipe()
    p.standardOutput = pipe
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    let d = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Invoke a class method that returns an object: (NSString, NSErrorPointer) -> id
func callClassMethod(_ className: String, _ selName: String, _ arg: NSString, _ err: NSErrorPointer) -> AnyObject? {
    guard let cls: AnyClass = NSClassFromString(className) else {
        fatal("class not found: \(className)")
    }
    let sel = NSSelectorFromString(selName)
    guard let m = class_getClassMethod(cls, sel) else {
        fatal("class method not found: +[\(className) \(selName)]")
    }
    typealias Fn = @convention(c) (AnyClass, Selector, NSString, NSErrorPointer) -> Unmanaged<AnyObject>?
    let fn = unsafeBitCast(method_getImplementation(m), to: Fn.self)
    return fn(cls, sel, arg, err)?.takeUnretainedValue()
}

/// Invoke an instance method returning id, taking an optional NSErrorPointer.
func callError(_ obj: AnyObject, _ selName: String, _ err: NSErrorPointer) -> AnyObject? {
    let sel = NSSelectorFromString(selName)
    guard obj.responds(to: sel), let m = class_getInstanceMethod(type(of: obj), sel) else {
        return nil
    }
    typealias Fn = @convention(c) (AnyObject, Selector, NSErrorPointer) -> Unmanaged<AnyObject>?
    let fn = unsafeBitCast(method_getImplementation(m), to: Fn.self)
    return fn(obj, sel, err)?.takeUnretainedValue()
}

/// Invoke a zero-arg instance method returning id (property getter).
func callObj(_ obj: AnyObject, _ selName: String) -> AnyObject? {
    let sel = NSSelectorFromString(selName)
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel)?.takeUnretainedValue()
}

/// Invoke a zero-arg instance method returning an IOSurfaceRef (CFType).
///
/// The display descriptor is an XPC remote proxy that resolves the call via
/// -forwardInvocation:, so we must dispatch through normal messaging
/// (-performSelector:) rather than method_getImplementation, which only sees the
/// proxy's own (non-forwarded) methods. IOSurfaceRef is an Obj-C object
/// (__IOSurface) under the hood, so we bit-cast the returned id back to it.
func callSurface(_ obj: AnyObject, _ selName: String) -> IOSurfaceRef? {
    let sel = NSSelectorFromString(selName)
    guard let result = obj.perform(sel) else { return nil }
    let surfaceObj = result.takeUnretainedValue()
    return unsafeBitCast(surfaceObj, to: IOSurfaceRef.self)
}

// MARK: - Device / display resolution

func resolveDevice(udid: String, developerDir: String?) -> AnyObject {
    var err: NSError?
    // CoreSimulator's -[SimServiceContext sharedServiceContextForDeveloperDir:]
    // calls sim_realPath on the argument and crashes on a nil/empty string, so we
    // must always pass a concrete developer dir.
    var resolvedDevDir = developerDir ?? ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
    if resolvedDevDir == nil || resolvedDevDir!.isEmpty {
        resolvedDevDir = runXcodeSelect()
    }
    if resolvedDevDir == nil || resolvedDevDir!.isEmpty {
        resolvedDevDir = "/Applications/Xcode.app/Contents/Developer"
    }
    let devDir = resolvedDevDir! as NSString
    guard let ctx = callClassMethod("SimServiceContext", "sharedServiceContextForDeveloperDir:error:", devDir, &err) else {
        fatal("sharedServiceContextForDeveloperDir failed: \(err?.localizedDescription ?? "nil")")
    }
    guard let deviceSet = callError(ctx, "defaultDeviceSetWithError:", &err) else {
        fatal("defaultDeviceSetWithError failed: \(err?.localizedDescription ?? "nil")")
    }
    guard let devices = callObj(deviceSet, "devices") as? [AnyObject] else {
        fatal("deviceSet.devices returned nil")
    }
    for d in devices {
        if let u = callObj(d, "UDID"), String(describing: u).lowercased() == udid.lowercased() {
            return d
        }
    }
    fatal("simulator udid not found: \(udid)")
}

/// List the Obj-C instance methods of an object's class (best-effort, for --dump).
func methodNames(_ obj: AnyObject) -> [String] {
    var names: [String] = []
    var cls: AnyClass? = type(of: obj)
    var depth = 0
    while let c = cls, depth < 4 {
        var count: UInt32 = 0
        if let methods = class_copyMethodList(c, &count) {
            for i in 0..<Int(count) {
                let sel = method_getName(methods[i])
                names.append(NSStringFromSelector(sel))
            }
            free(methods)
        }
        cls = class_getSuperclass(c)
        depth += 1
    }
    return names
}

/// List the selectors declared by a named Obj-C protocol (required + optional).
func protocolSelectors(_ protoName: String) -> [String] {
    guard let proto = objc_getProtocol(protoName) else { return [] }
    var out: [String] = []
    for required in [true, false] {
        for instance in [true, false] {
            var count: UInt32 = 0
            if let descs = protocol_copyMethodDescriptionList(proto, required, instance, &count) {
                for i in 0..<Int(count) {
                    if let sel = descs[i].name {
                        out.append(NSStringFromSelector(sel))
                    }
                }
                free(descs)
            }
        }
    }
    return out
}

/// Print the IO client / port / descriptor topology for selector discovery.
func dumpDisplayInfo(device: AnyObject) {
    for p in ["SimDisplayIOSurfaceRenderable", "SimDisplayRenderable", "SimDisplayResizeableRenderable", "SimScreen"] {
        log("dump: protocol \(p) selectors = \(protocolSelectors(p).joined(separator: ","))")
    }
    guard let ioClient = callObj(device, "io") else {
        log("dump: device.io returned nil (booted?)"); return
    }
    log("dump: ioClient class = \(String(describing: type(of: ioClient)))")
    log("dump: ioClient methods = \(methodNames(ioClient).joined(separator: ","))")
    guard let ports = callObj(ioClient, "ioPorts") as? [AnyObject] else {
        log("dump: ioClient.ioPorts returned nil"); return
    }
    log("dump: ioPorts count = \(ports.count)")
    for (i, port) in ports.enumerated() {
        log("dump: port[\(i)] class = \(String(describing: type(of: port)))")
        log("dump: port[\(i)] methods = \(methodNames(port).joined(separator: ","))")
        if let descriptor = callObj(port, "descriptor") {
            let dname = String(describing: type(of: descriptor))
            log("dump: port[\(i)].descriptor class = \(dname)")
            log("dump: port[\(i)].descriptor methods = \(methodNames(descriptor).joined(separator: ","))")
            // For the display descriptor, the real (forwarded) interface lives in
            // the proxy's selectorsToMethodSignatures map, not its own methods.
            if dname.contains("SimDisplay") || dname.contains("SimScreen") {
                if let map = callObj(descriptor, "selectorsToMethodSignatures") as? [AnyHashable: Any] {
                    let keys = map.keys.map { "\($0)" }.sorted().joined(separator: ",")
                    log("dump: port[\(i)].descriptor forwardedSelectors = \(keys)")
                } else {
                    log("dump: port[\(i)].descriptor selectorsToMethodSignatures = nil")
                }
            }
        } else {
            log("dump: port[\(i)].descriptor = nil")
        }
    }
}

/// Find the IOSurface-renderable display port on the device's IO client.
///
/// The IO ports are XPC remote proxies (ROCKRemoteProxy) that forward via
/// -forwardInvocation:, so -respondsToSelector: is unreliable for the forwarded
/// interface. Instead we match on the protocol names baked into the proxy's
/// runtime class name, e.g. "...-SimDisplayIOSurfaceRenderable-...". The main
/// device display also reports "SimScreen" / "SimDisplayRenderable".
func resolveDisplayRenderable(device: AnyObject) -> AnyObject {
    guard let ioClient = callObj(device, "io") else {
        fatal("device.io (SimDeviceIOClient) returned nil — is the simulator booted?")
    }
    guard let ports = callObj(ioClient, "ioPorts") as? [AnyObject] else {
        fatal("ioClient.ioPorts returned nil")
    }

    func conformsToSurfaceRenderable(_ obj: AnyObject) -> Bool {
        let name = String(describing: type(of: obj))
        return name.contains("SimDisplayIOSurfaceRenderable")
    }

    // Prefer the primary device display (SimScreen) over auxiliary surfaces.
    var fallback: AnyObject? = nil
    for port in ports {
        let descriptor = callObj(port, "descriptor") ?? port
        guard conformsToSurfaceRenderable(descriptor) else { continue }
        let name = String(describing: type(of: descriptor))
        if name.contains("SimScreen") || name.contains("SimDisplayRenderable") {
            return descriptor
        }
        if fallback == nil { fallback = descriptor }
    }
    if let f = fallback { return f }
    fatal("no SimDisplayIOSurfaceRenderable port found on device")
}

// MARK: - VideoToolbox encoder

final class Encoder {
    private var session: VTCompressionSession?
    private(set) var width: Int = 0
    private(set) var height: Int = 0
    private let bitrate: Int
    private let fps: Int
    private let keyframeIntervalSec: Double
    private var emittedReady = false
    let startTime = CFAbsoluteTimeGetCurrent()

    init(bitrate: Int, fps: Int, keyframeIntervalSec: Double) {
        self.bitrate = bitrate
        self.fps = fps
        self.keyframeIntervalSec = keyframeIntervalSec
    }

    func ensureSession(width: Int, height: Int) {
        if session != nil && self.width == width && self.height == height { return }
        teardown()
        self.width = width
        self.height = height

        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &s)
        guard status == noErr, let session = s else {
            fatal("VTCompressionSessionCreate failed: \(status)")
        }
        self.session = session

        func setProp(_ key: CFString, _ value: CFTypeRef) {
            VTSessionSetProperty(session, key: key, value: value)
        }
        setProp(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        setProp(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        setProp(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel)
        setProp(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
        setProp(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps))
        let gop = max(1, Int(Double(fps) * keyframeIntervalSec))
        setProp(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: gop))
        setProp(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: keyframeIntervalSec))
        if #available(macOS 11.0, *) {
            setProp(kVTCompressionPropertyKey_MaximizePowerEfficiency, kCFBooleanFalse)
        }
        // Cap latency: do not let the encoder buffer frames.
        setProp(kVTCompressionPropertyKey_DataRateLimits, [NSNumber(value: bitrate / 8 * 2), NSNumber(value: 1)] as CFArray)
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("encoder ready \(width)x\(height) @\(fps)fps bitrate=\(bitrate) gop=\(gop)")
    }

    func encode(pixelBuffer: CVPixelBuffer, forceKeyframe: Bool) {
        guard let session = session else { return }
        let pts = CMTime(value: Int64((CFAbsoluteTimeGetCurrent() - startTime) * 1_000_000), timescale: 1_000_000)
        var props: CFDictionary? = nil
        if forceKeyframe {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: props,
            infoFlagsOut: nil) { [weak self] status, _, sampleBuffer in
                guard status == noErr, let sb = sampleBuffer else { return }
                self?.handleEncoded(sb)
            }
    }

    private func handleEncoded(_ sb: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sb) else { return }
        let isKeyframe = !cmSampleIsNotSync(sb)
        var out = Data()

        if isKeyframe, let fmt = CMSampleBufferGetFormatDescription(sb) {
            // Prepend SPS/PPS as Annex-B before every IDR (in-band CONFIG).
            for ps in parameterSets(fmt) {
                out.append(contentsOf: [0, 0, 0, 1])
                out.append(ps)
            }
        }

        guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
        var lengthAtOffset = 0
        var totalLength = 0
        var dataPtr: UnsafeMutablePointer<Int8>? = nil
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
                                          totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == noErr,
              let base = dataPtr else { return }

        // AVCC → Annex-B: each NAL is [4-byte BE length][payload].
        var offset = 0
        let buf = UnsafeRawPointer(base)
        while offset + 4 <= totalLength {
            let nalLen = Int(UInt32(bigEndian: buf.load(fromByteOffset: offset, as: UInt32.self)))
            offset += 4
            if nalLen <= 0 || offset + nalLen > totalLength { break }
            out.append(contentsOf: [0, 0, 0, 1])
            out.append(Data(bytes: base + offset, count: nalLen))
            offset += nalLen
        }

        if out.isEmpty { return }
        emitAccessUnit(out)
        if !emittedReady {
            emittedReady = true
            emitLine("READY")
        }
    }

    private func parameterSets(_ fmt: CMFormatDescription) -> [Data] {
        var sets: [Data] = []
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: nil)
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>? = nil
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i,
                                                                  parameterSetPointerOut: &ptr,
                                                                  parameterSetSizeOut: &size,
                                                                  parameterSetCountOut: nil,
                                                                  nalUnitHeaderLengthOut: nil) == noErr,
               let p = ptr {
                sets.append(Data(bytes: p, count: size))
            }
        }
        return sets
    }

    func teardown() {
        if let session = session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
    }
}

func cmSampleIsNotSync(_ sb: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false),
          CFArrayGetCount(attachments) > 0 else { return false }
    let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
    let key = Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
    var value: UnsafeRawPointer? = nil
    if CFDictionaryGetValueIfPresent(dict, key, &value), let v = value {
        return CFBooleanGetValue(unsafeBitCast(v, to: CFBoolean.self))
    }
    return false
}

// MARK: - Pixel buffer from IOSurface (zero-copy)

func pixelBuffer(from surface: IOSurfaceRef) -> CVPixelBuffer? {
    var pbUnmanaged: Unmanaged<CVPixelBuffer>? = nil
    let attrs: [CFString: Any] = [
        kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary
    ]
    let status = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, attrs as CFDictionary, &pbUnmanaged)
    if status != kCVReturnSuccess { return nil }
    return pbUnmanaged?.takeRetainedValue()
}

// MARK: - Main

let args = parseArgs()
if args.udid.isEmpty { fatal("--udid is required") }
loadCoreSimulator()

let device = resolveDevice(udid: args.udid, developerDir: args.developerDir)

if args.dump {
    dumpDisplayInfo(device: device)
    exit(0)
}

let renderable = resolveDisplayRenderable(device: device)

if args.probeOnly {
    if let surface = callSurface(renderable, "framebufferSurface") {
        let w = IOSurfaceGetWidth(surface)
        let h = IOSurfaceGetHeight(surface)
        emitLine("PROBE_OK \(w)x\(h)")
        exit(0)
    }
    fatal("probe: framebufferSurface unavailable")
}

let encoder = Encoder(bitrate: args.bitrate, fps: args.fps, keyframeIntervalSec: args.keyframeIntervalSec)
var forceKeyframe = true        // first frame must be an IDR
var emittedGeometry = false
let frameLock = NSLock()
var latestSurface: IOSurfaceRef? = nil

// Backing scale: device pixels / logical points. Derive from device chars when
// available; the Node side recomputes device_logical from the simctl model too.
func emitGeometry(width: Int, height: Int) {
    if emittedGeometry { return }
    emittedGeometry = true
    // Surface is device pixels. Logical points = pixels / scale; scale is filled
    // in by the Node wrapper from the simctl device model (authoritative). Here
    // we report the raw capture surface + fps so the wrapper can build geometry.
    let json = "{\"capture_surface\":{\"w\":\(width),\"h\":\(height)},\"fps\":\(args.fps),\"udid\":\"\(args.udid)\"}"
    emitLine("GEOMETRY \(json)")
}

// stdin reader: 'K' forces an IDR (renegotiation / new subscriber).
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor)
stdinSource.setEventHandler {
    let d = FileHandle.standardInput.availableData
    if d.isEmpty { return }
    if d.contains(UInt8(ascii: "K")) {
        frameLock.lock(); forceKeyframe = true; frameLock.unlock()
        log("force-IDR requested")
    }
}
stdinSource.resume()

// Encode loop driven by a frame tick. We pull the current ioSurface on each
// surface-change callback and also poll at the target fps as a safety net for
// static screens (where change callbacks may be sparse).
func tick() {
    guard let surface = callSurface(renderable, "framebufferSurface") else { return }
    let w = IOSurfaceGetWidth(surface)
    let h = IOSurfaceGetHeight(surface)
    if w == 0 || h == 0 { return }
    emitGeometry(width: w, height: h)
    encoder.ensureSession(width: w, height: h)
    guard let pb = pixelBuffer(from: surface) else { return }
    frameLock.lock()
    let force = forceKeyframe
    forceKeyframe = false
    frameLock.unlock()
    encoder.encode(pixelBuffer: pb, forceKeyframe: force)
}

// Register the surface-change callback (resolved dynamically). The real
// selector on SimDisplayIOSurfaceRenderable is the plural "ioSurfacesChange".
let regSel = NSSelectorFromString("registerCallbackWithUUID:ioSurfacesChangeCallback:")
let uuid = NSUUID()
let changeBlock: @convention(block) (AnyObject?) -> Void = { _ in tick() }
_ = renderable.perform(regSel, with: uuid, with: changeBlock)
log("registered ioSurfaces change callback")

// Steady fps polling timer (also covers static frames + paces the encoder).
let timerQueue = DispatchQueue(label: "coresim.timer")
let timer = DispatchSource.makeTimerSource(queue: timerQueue)
timer.schedule(deadline: .now(), repeating: .milliseconds(Int(1000.0 / Double(max(1, args.fps)))))
timer.setEventHandler { tick() }
timer.resume()

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
log("capture started udid=\(args.udid)")
RunLoop.main.run()
