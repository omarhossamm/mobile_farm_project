import WebSocket from 'ws';

/**
 * One device entry as reported by the gateway server's `get_devices`
 * response. Field names mirror the server payload so we can pass this
 * shape through to the desktop app's --device argument without translation.
 *
 * `in_use` / `owner_session_id` are annotations the server adds so we
 * can pre-flight-check whether a `create_session` request will succeed.
 * If `in_use === true`, a different WebSocket owns this device right
 * now and any attempt to create a session on it will be rejected —
 * we surface a friendly error instead of running Flutter first.
 */
export interface DeviceEntry {
  device_id: string;
  platform?: string;
  status?: string;
  name?: string;
  avd_name?: string;
  in_use?: boolean;
  owner_session_id?: string | null;
}

/**
 * Open a short-lived WebSocket to the server, ask for the device list,
 * then close the connection. This is the only piece of protocol code
 * the extension itself needs — everything else (session creation,
 * WebRTC handshake, control channel, freeze recovery…) is owned by
 * the EmulatorDesktopApp that we launch afterwards.
 *
 * localhost vs 127.0.0.1: Node 18+ resolves `localhost` to IPv6 (::1)
 * first. If the server binds IPv4-only, that fails with ECONNREFUSED.
 * We rewrite `localhost` to `127.0.0.1` defensively — the desktop app
 * gets the *original* server URL untouched so it stays consistent
 * with what the user configured.
 */
export async function fetchDevices(server: string, timeoutMs = 5000): Promise<DeviceEntry[]> {
  const normalized = server.replace(/^(ws{1,2}s?):\/\/localhost([:/])/i, '$1://127.0.0.1$2');
  const ws = new WebSocket(normalized);

  return new Promise<DeviceEntry[]>((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, devices?: DeviceEntry[]) => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(devices ?? []);
    };
    const timer = setTimeout(() => finish(new Error(`Timed out fetching devices from ${normalized}`)), timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'get_devices' }));
      } catch (e) {
        clearTimeout(timer);
        finish(e as Error);
      }
    });
    ws.on('message', (raw) => {
      let parsed: any;
      try { parsed = JSON.parse(raw.toString()); }
      catch { return; }
      // Server variants: `devices_list`, `get_devices_response`, `list_devices_response`.
      const t = parsed?.type;
      if (t !== 'devices_list' && t !== 'get_devices_response' && t !== 'list_devices_response') return;
      clearTimeout(timer);
      const devices = extractDevices(parsed);
      finish(null, devices);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      finish(new Error(`Server closed connection before returning devices (${normalized})`));
    });
  });
}

function extractDevices(msg: any): DeviceEntry[] {
  const list = msg?.data?.devices ?? msg?.devices ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any) => ({
    device_id: String(d.device_id ?? d.id ?? ''),
    platform: d.platform,
    status: d.status,
    name: d.name,
    avd_name: d.avd_name,
    in_use: d.in_use === true,
    owner_session_id: d.owner_session_id ?? null,
  })).filter(d => d.device_id.length > 0);
}
