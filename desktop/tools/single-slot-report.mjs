export function singleSlotChecks(report) {
  const normalize = value => value.replace(/\\/g, '/').toLowerCase();
  const expected = normalize(`${report.root}/vault/特征分解.md`);
  const notes = report.cases.filter(item => ['single-slot-notes', 'single-slot-follow-up'].includes(item.name));
  const hasSource = text => [...text.matchAll(/summon-file:([^\s`<>\)]+)/g)].some(match => {
    try {
      const [file, line] = decodeURIComponent(match[1]).split('#');
      return normalize(file) === expected && /^L\d+(?:-L\d+)?$/.test(line || '');
    } catch { return false; }
  });
  return {
    queueObserved: report.queuedCancellation?.observed === true,
    cancelledMainNotSent: report.queuedCancellation?.sentMainRequest === false,
    overviewReady: report.overviewReady === true,
    upstreamPeakOne: report.upstreamPeak === 1,
    completedUpstream: report.requests.length === 4 && report.requests.every(request => request.status === 200 && request.streamComplete),
    notesEvidence: notes.length === 2 && new Set(notes.map(item => item.name)).size === 2 && notes.every(item => item.outcome?.status === 'complete' && hasSource(item.text) && /青铜海燕/.test(item.text) && /紫色/.test(item.text) && /定向杆/.test(item.text)),
  };
}
