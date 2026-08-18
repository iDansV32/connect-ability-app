// Workflow run history — list of past runs + per-run detail view with
// per-prospect step results and a "save as group" action.

const { useState: useStateWH, useEffect: useEffectWH, useMemo: useMemoWH } = React;

const OUTCOME_LABELS = {
  completed: 'Completed',
  skipped_already_connected: 'Skipped — already connected',
  skipped_invite_pending: 'Skipped — invite pending',
  skipped_not_connected: 'Skipped — not connected',
  skipped_no_post: 'Skipped — no recent posts',
  skipped_thread_exists: 'Skipped — recent thread exists',
  skipped_quota_exceeded: 'Skipped — daily quota reached',
  skipped_do_not_contact: 'Skipped — do not contact',
  skipped_outside_working_hours: 'Skipped — outside working hours',
  skipped_budget_exceeded: 'Skipped — daily budget reached',
  skipped_managed_elsewhere: 'Skipped — managed elsewhere',
  skipped_transport_unhealthy: 'Skipped — transport unhealthy',
  skipped_already_following: 'Skipped — already following',
  skipped_no_endorseable_skills: 'Skipped — no skills to endorse',
  skipped_already_endorsed: 'Skipped — already endorsed',
  skipped_comment_unavailable: 'Skipped — no commentable post',
  skipped_not_following: 'Skipped — not following',
  failed_transient: 'Failed — will retry',
  failed_permanent: 'Failed — permanent',
};

function outcomeTone(outcome) {
  if (!outcome) return 'muted';
  if (outcome === 'completed') return 'ok';
  if (String(outcome).startsWith('skipped_')) return 'warn';
  if (String(outcome).startsWith('failed_')) return 'danger';
  return 'muted';
}

function outcomeColor(outcome) {
  const tone = outcomeTone(outcome);
  if (tone === 'ok') return 'var(--ok-text)';
  if (tone === 'warn') return 'var(--warn-text)';
  if (tone === 'danger') return 'var(--danger-text)';
  return 'var(--text-3)';
}

function runStatusMeta(statusRaw) {
  const status = String(statusRaw || '').toLowerCase();
  if (status === 'completed') return { label: 'Completed', tone: 'ok', icon: 'Check' };
  if (status === 'running') return { label: 'Running', tone: 'info', icon: 'Play' };
  if (status === 'paused') return { label: 'Paused', tone: 'warn', icon: 'Pause' };
  if (status === 'cancelled') return { label: 'Cancelled', tone: 'muted', icon: 'X' };
  if (status === 'failed') return { label: 'Failed', tone: 'danger', icon: 'Warn' };
  if (status === 'queued') return { label: 'Queued', tone: 'info', icon: 'Clock' };
  return { label: status ? status[0].toUpperCase() + status.slice(1) : 'Draft', tone: 'muted', icon: 'Workflow' };
}

function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function recipientNameFromUrl(url) {
  if (!url) return '';
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  if (!m) return '';
  return decodeURIComponent(m[1]).replace(/-/g, ' ');
}

function stepLabel(stepType) {
  const def = window.WF && WF.stepTypes ? WF.stepTypes[stepType] : null;
  return (def && def.label) || String(stepType || 'unknown').replace(/_/g, ' ');
}

function stepIconName(stepType) {
  const def = window.WF && WF.stepTypes ? WF.stepTypes[stepType] : null;
  return (def && def.icon) || 'Workflow';
}

function openExternalLink(url) {
  if (!url) return;
  if (window.electronAPI && window.electronAPI.send) {
    window.electronAPI.send('open-external', url);
  }
}

function pct(part, total) {
  if (!total || total <= 0 || !part || part <= 0) return 0;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function StatusPill({ status }) {
  const meta = runStatusMeta(status);
  const Icon = Ic[meta.icon] || Ic.Workflow;
  return (
    <span className={`wf-status wf-status--${meta.tone}`}>
      <Icon cls="icon icon--sm" />
      {meta.label}
    </span>
  );
}

function OutcomePill({ outcome }) {
  if (!outcome) return <span className="wf-outcome wf-outcome--muted">—</span>;
  const tone = outcomeTone(outcome);
  return (
    <span className={`wf-outcome wf-outcome--${tone}`} title={OUTCOME_LABELS[outcome] || outcome}>
      {OUTCOME_LABELS[outcome] || outcome}
    </span>
  );
}

function HistoryMeta({ icon, label, value }) {
  const Icon = Ic[icon] || Ic.Info;
  return (
    <div className="wf-meta">
      <Icon cls="icon icon--sm" />
      <span className="wf-meta__label">{label}</span>
      <span className="wf-meta__value">{value || '—'}</span>
    </div>
  );
}

function RunStat({ label, value, tone = 'default' }) {
  return (
    <div className={`wf-stat wf-stat--${tone}`}>
      <span className="wf-stat__label">{label}</span>
      <span className="wf-stat__value tabular">{value}</span>
    </div>
  );
}

function MetricCard({ label, value, sub, icon = 'Workflow' }) {
  const Icon = Ic[icon] || Ic.Workflow;
  return (
    <div className="wf-metric">
      <div className="wf-metric__head">
        <span className="wf-metric__icon"><Icon cls="icon icon--sm" /></span>
        <span className="wf-metric__label">{label}</span>
      </div>
      <div className="wf-metric__value">{value}</div>
      {Array.isArray(sub) && sub.length > 0 && (
        <div className="wf-metric__sub">{sub}</div>
      )}
    </div>
  );
}

function WorkflowRunsList({ runs, onSelectRun, onOpenInEditor, onDeleteRun }) {
  const sorted = useMemoWH(() => {
    const list = Array.isArray(runs) ? [...runs] : [];
    list.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    return list;
  }, [runs]);

  if (sorted.length === 0) {
    return (
      <div className="wf-empty wf-empty--history">
        <div className="wf-empty__icon"><Ic.Workflow cls="icon icon--lg" /></div>
        <div className="eyebrow">Run history</div>
        <h2 className="wf-empty__title">No runs yet</h2>
        <p className="wf-empty__copy">
          Build a workflow on the Editor tab and click Launch to create your first run.
        </p>
      </div>
    );
  }

  return (
    <div className="wf-runs-page">
      <div className="wf-history__head">
        <div>
          <div className="eyebrow">Run history</div>
          <h2 className="wf-history__title">{sorted.length} run{sorted.length === 1 ? '' : 's'}</h2>
        </div>
      </div>

      <div className="wf-runs-page__list">
        {sorted.map((run) => {
          const summary = run.summary || {};
          const total = summary.totalTargets || (Array.isArray(run.targets) ? run.targets.length : 0);
          const completed = summary.completedTargets || 0;
          const replied = summary.repliedTargets || 0;
          const runId = run.id || run.runId;
          const meta = runStatusMeta(run.status);
          const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
          const chipTone = meta.tone === 'ok' ? 'chip--ok'
            : meta.tone === 'warn' ? 'chip--warn'
            : meta.tone === 'danger' ? 'chip--danger'
            : meta.tone === 'info' ? 'chip--info'
            : 'chip--line';
          const agentName = run.agentName || 'Unassigned';
          return (
            <div key={runId} className="run-card">
              <span className={`chip ${chipTone}`} style={{ minWidth: 88, justifyContent: 'center' }}>
                <span className={`dot ${meta.tone === 'ok' ? 's-ok' : meta.tone === 'warn' ? 's-warn' : meta.tone === 'danger' ? 's-danger' : meta.tone === 'info' ? 's-info' : 's-dim'} ${String(run.status || '').toLowerCase() === 'running' ? 'dot--pulse' : ''}`} />
                {meta.label}
              </span>

              <button
                type="button"
                className="run-card__main"
                onClick={() => onSelectRun(runId)}
              >
                <div className="run-card__title">{run.workflowName || run.name || runId}</div>
                <div className="row gap-2" style={{ marginTop: 6 }}>
                  <span className="bar" style={{ flex: 1, maxWidth: 280 }}>
                    <span className="bar__fill" style={{ width: `${progress}%` }} />
                  </span>
                  <span className="mono s-dim tabular" style={{ fontSize: 12 }}>{completed}/{total}</span>
                </div>
                <div className="wf-run-inline-meta">
                  <span>{run.accountName || 'No account'}</span>
                  <span>•</span>
                  <span>{run.targetType || 'Manual target'}</span>
                  <span>•</span>
                  <span>{fmtDate(run.createdAt)}</span>
                </div>
              </button>

              <div className="row gap-2 run-card__agent">
                <Avatar name={agentName} size={24} gradient />
                <span style={{ fontSize: 13 }}>{agentName}</span>
              </div>

              <div className="col run-card__replies">
                <span className="tabular" style={{ fontWeight: 600 }}>{replied}</span>
                <span className="s-dim" style={{ fontSize: 11 }}>replies</span>
              </div>

              <div className="row gap-1 run-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => onSelectRun(runId)}>
                  <Ic.Eye cls="icon icon--sm" />
                </button>
                {onOpenInEditor && (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => onOpenInEditor(run)}
                  >
                    <Ic.Workflow cls="icon icon--sm" />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--sm btn--warn"
                  onClick={() => onDeleteRun && onDeleteRun(run)}
                >
                  <Ic.Trash cls="icon icon--sm" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowRunDetail({ run, jobs, onBack, onOpenInEditor, onSaveAsGroup, onReload, onDelete }) {
  const perTarget = useMemoWH(() => {
    if (!run) return [];
    const targets = Array.isArray(run.targets) ? run.targets : [];
    return targets.map((target) => {
      const targetJobs = jobs.filter((job) => job.targetId === target.targetId || job.targetValue === target.value);
      const byStep = {};
      for (const job of targetJobs) byStep[job.stepIndex] = job;
      return { target, byStep, jobs: targetJobs };
    });
  }, [run, jobs]);

  const metrics = useMemoWH(() => {
    const out = {
      totalTargets: (run && run.summary && run.summary.totalTargets) || (run && run.targets ? run.targets.length : 0),
      stepBreakdown: {},
    };
    for (const job of jobs) {
      const stepType = job.stepType || 'unknown';
      const row = out.stepBreakdown[stepType] = out.stepBreakdown[stepType] || { completed: 0, skipped: 0, failed: 0, total: 0 };
      row.total += 1;
      const outcome = (job.result && job.result.outcomeType) || job.status;
      if (outcome === 'completed') row.completed += 1;
      else if (String(outcome).startsWith('skipped_')) row.skipped += 1;
      else if (String(outcome).startsWith('failed_')) row.failed += 1;
    }
    return out;
  }, [run, jobs]);

  const steps = Array.isArray(run && run.steps) ? run.steps : [];
  const [selectedTargetIds, setSelectedTargetIds] = useStateWH(() => new Set());
  const [groupFilter, setGroupFilter] = useStateWH('all');
  const [groupName, setGroupName] = useStateWH('');
  const [savingGroup, setSavingGroup] = useStateWH(false);

  useEffectWH(() => {
    if (!run) return;
    const baseName = run.workflowName || run.name || 'Run';
    const suffix = new Date(run.createdAt || Date.now()).toISOString().slice(0, 10);
    setGroupName(`${baseName} — ${suffix}`);
    setGroupFilter('all');
  }, [run && (run.id || run.runId)]);

  useEffectWH(() => {
    if (groupFilter === 'all') {
      setSelectedTargetIds(new Set(perTarget.map((row) => row.target.targetId)));
      return;
    }
    const next = new Set();
    for (const row of perTarget) {
      const matches = row.jobs.some((job) => {
        const outcome = (job.result && job.result.outcomeType) || job.status;
        if (groupFilter === 'completed') return outcome === 'completed';
        if (groupFilter === 'skipped') return String(outcome).startsWith('skipped_');
        if (groupFilter === 'failed') return String(outcome).startsWith('failed_');
        return false;
      });
      if (matches) next.add(row.target.targetId);
    }
    setSelectedTargetIds(next);
  }, [groupFilter, perTarget]);

  const toggleTarget = (id) => {
    setSelectedTargetIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveAsGroup = async () => {
    const name = (groupName || '').trim();
    if (!name) { window.alert('Give the group a name first'); return; }
    const urls = perTarget
      .filter((row) => selectedTargetIds.has(row.target.targetId))
      .map((row) => row.target.value)
      .filter(Boolean);
    if (urls.length === 0) { window.alert('No profiles selected'); return; }
    setSavingGroup(true);
    try {
      await onSaveAsGroup({ name, urls });
    } finally {
      setSavingGroup(false);
    }
  };

  if (!run) {
    return (
      <div className="wf-empty wf-empty--history">
        <div className="wf-empty__icon"><Ic.Warn cls="icon icon--lg" /></div>
        <h2 className="wf-empty__title">Run not found</h2>
        <p className="wf-empty__copy">The selected workflow run is no longer available.</p>
        <button className="btn" type="button" onClick={onBack}>
          <Ic.ChevronLeft cls="icon icon--sm" />Back
        </button>
      </div>
    );
  }

  const statusMeta = runStatusMeta(run.status);
  const selectedCount = selectedTargetIds.size;
  const detailStats = [
    { label: 'Prospects', value: metrics.totalTargets, icon: 'Prospects' },
    { label: 'Completed', value: run.summary && run.summary.completedTargets ? run.summary.completedTargets : 0, icon: 'Check' },
    { label: 'Replies', value: run.summary && run.summary.repliedTargets ? run.summary.repliedTargets : 0, icon: 'Inbox' },
    { label: 'Failures', value: run.summary && run.summary.failedTargets ? run.summary.failedTargets : 0, icon: 'Warn' },
  ];

  return (
    <div className="wf-detail">
      <div className="wf-detail__toolbar">
        <button className="btn btn--ghost btn--sm" type="button" onClick={onBack}>
          <Ic.ChevronLeft cls="icon icon--sm" />Back to runs
        </button>
        <div className="wf-detail__toolbar-actions">
          <button className="btn btn--sm" type="button" onClick={onReload}>
            <Ic.Refresh cls="icon icon--sm" />Refresh
          </button>
          <button className="btn btn--primary btn--sm" type="button" onClick={onOpenInEditor}>
            <Ic.Workflow cls="icon icon--sm" />Open in editor
          </button>
          <button className="btn btn--warn btn--sm" type="button" onClick={onDelete}>
            <Ic.Trash cls="icon icon--sm" />Delete run
          </button>
        </div>
      </div>

      <div className="wf-detail__hero">
        <div className="wf-detail__hero-main">
          <StatusPill status={run.status} />
          <h2 className="wf-detail__title">{run.workflowName || run.name || run.id}</h2>
          <div className="wf-detail__meta">
            <HistoryMeta icon="User" label="Agent" value={run.agentName || 'Unassigned'} />
            <HistoryMeta icon="Link" label="Account" value={run.accountName || '—'} />
            <HistoryMeta icon="Calendar" label="Created" value={fmtDate(run.createdAt)} />
            <HistoryMeta icon="Clock" label="Finished" value={run.completedAt ? fmtDate(run.completedAt) : 'Still active'} />
            <HistoryMeta icon="Filter" label="Targeting" value={run.targetType || '—'} />
          </div>
        </div>

        <div className="wf-detail__hero-stats">
          {detailStats.map((stat) => (
            <MetricCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} />
          ))}
        </div>
      </div>

      <div className="wf-detail__metrics">
        {Object.entries(metrics.stepBreakdown).map(([stepType, row]) => (
          <MetricCard
            key={stepType}
            label={stepLabel(stepType)}
            value={`${row.completed} / ${row.total}`}
            icon={stepIconName(stepType)}
            sub={[
              row.completed > 0 && <span key="c" className="wf-metric__pill wf-metric__pill--ok">{row.completed} completed</span>,
              row.skipped > 0 && <span key="s" className="wf-metric__pill wf-metric__pill--warn">{row.skipped} skipped</span>,
              row.failed > 0 && <span key="f" className="wf-metric__pill wf-metric__pill--danger">{row.failed} failed</span>,
            ].filter(Boolean)}
          />
        ))}
      </div>

      <div className="wf-savebox">
        <div className="wf-savebox__head">
          <div>
            <div className="eyebrow">Save as group</div>
            <div className="wf-savebox__title">Turn this run into a reusable prospect set</div>
          </div>
          <span className="wf-savebox__count mono">{selectedCount} selected</span>
        </div>
        <div className="wf-savebox__grid">
          <label className="wf-savebox__field">
            <span className="field-label">Group name</span>
            <input
              className="input"
              placeholder="Group name"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          </label>
          <label className="wf-savebox__field">
            <span className="field-label">Include</span>
            <select className="input" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="all">All prospects</option>
              <option value="completed">Only completed</option>
              <option value="skipped">Only skipped</option>
              <option value="failed">Only failed</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn--primary wf-savebox__button"
            onClick={handleSaveAsGroup}
            disabled={savingGroup || selectedCount === 0}
          >
            <Ic.Bookmark cls="icon icon--sm" />
            {savingGroup ? 'Saving…' : `Save group (${selectedCount})`}
          </button>
        </div>
        <div className="field-hint">Tick rows below to override the filter selection before saving.</div>
      </div>

      <div className="wf-tablecard">
        <div className="wf-tablecard__head">
          <div className="eyebrow">Prospects</div>
          <div className="wf-tablecard__title">{perTarget.length} target{perTarget.length === 1 ? '' : 's'}</div>
        </div>

        <div className="wf-tablewrap">
          <table className="wf-table">
            <thead>
              <tr>
                <th className="wf-table__check"></th>
                <th>Profile</th>
                {steps.map((step, index) => (
                  <th key={index}>{index + 1}. {stepLabel(step.type)}</th>
                ))}
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {perTarget.map((row) => {
                const url = row.target.value || row.target.label || '';
                const name = recipientNameFromUrl(url);
                return (
                  <tr key={row.target.targetId}>
                    <td className="wf-table__check">
                      <input
                        type="checkbox"
                        checked={selectedTargetIds.has(row.target.targetId)}
                        onChange={() => toggleTarget(row.target.targetId)}
                      />
                    </td>
                    <td>
                      <div className="wf-profile">
                        <button
                          type="button"
                          className="wf-profile__link"
                          title={url}
                          onClick={() => openExternalLink(url)}
                        >
                          {name || url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '')}
                        </button>
                        <code className="wf-profile__url mono">{url.replace(/^https?:\/\//, '').slice(0, 60)}</code>
                      </div>
                    </td>
                    {steps.map((step, idx) => {
                      const job = row.byStep[idx];
                      if (!job) return <td key={idx}><span className="wf-outcome wf-outcome--muted">—</span></td>;
                      const outcome = (job.result && job.result.outcomeType) || job.status;
                      return (
                        <td key={idx}>
                          <OutcomePill outcome={outcome} />
                        </td>
                      );
                    })}
                    <td>
                      <span className="wf-state">{row.target.status || '—'}</span>
                    </td>
                  </tr>
                );
              })}
              {perTarget.length === 0 && (
                <tr>
                  <td colSpan={steps.length + 3} className="wf-table__empty">
                    No targets in this run yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WorkflowRunsList, WorkflowRunDetail });
