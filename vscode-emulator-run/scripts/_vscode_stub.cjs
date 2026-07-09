module.exports = {
  window: { withProgress: async (_o, fn) => fn({ report(){} }, { onCancellationRequested(){ return {dispose(){}}; }}) },
  CancellationTokenSource: class { get token(){ return { onCancellationRequested(){ return { dispose(){} }; } }; } cancel(){} dispose(){} },
  ProgressLocation: { Notification: 15 },
};
