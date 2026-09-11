/**
 * dsh-ctx-refresh — client half. (Rebuilt for the current 0.1.5-rc deployment:
 * same slot contracts and settingsScope API; only the snapshot-store supplier
 * changed — see below.)
 *
 * Hand-written bundle in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }),
 * with platform modules (react) resolved through the injected require.
 * The only non-react require is @deepseek-ai/dsh-client-store, which the shell
 * seeds into its frozen platform module table (the old supplier,
 * @deepseek-ai/dsh-client-runtime/client, no longer exists in that table).
 *
 * Two surfaces (the old sidebar.footer.action button is gone):
 *   1. Settings card in `settings.plugin.item` (key dsh-ctx-refresh): auto-sync
 *      enable toggle + interval minutes, a manual "立即刷新" button, and the
 *      last sync time/result line. Configuration lives in the host settings
 *      namespace bound through ctx.settingsScope; runtime state is polled from
 *      GET /ctx-refresh/state every 5s while mounted.
 *   2. Ambient readout chip in `conversation.composer.dock`: shows "正在同步…"
 *      while a sync runs and the result summary for ~2 minutes after it ends,
 *      so an auto-sync triggered by sending a message is visible right where
 *      messages are sent.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ctx-refresh',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    var inject = ['slots', 'settingsScope'];

    var STATE_URL = '/ctx-refresh/state';
    var REFRESH_URL = '/refresh-model-ctx';
    var POLL_MS = 5000;
    var RESULT_VISIBLE_MS = 120000;

    // ── shared helpers ──
    function formatResult(r) {
      if (!r || typeof r !== 'object') return '';
      if (r.ok === false) return '同步失败：' + String(r.message || '未知错误');
      var parts = [];
      if (r.updatedCount > 0) parts.push('已更新 ' + String(r.updatedCount) + ' 个模型');
      if (r.unchangedModels > 0) parts.push(String(r.unchangedModels) + ' 个无变化');
      if (r.noWindowModels > 0) parts.push(String(r.noWindowModels) + ' 个未报告窗口');
      if (r.skippedCount > 0) parts.push('跳过 ' + String(r.skippedCount) + ' 条路由');
      if (r.errorCount > 0) parts.push(String(r.errorCount) + ' 条失败');
      return parts.length > 0 ? parts.join(' · ') : '没有可刷新的模型';
    }

    function formatClock(ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
      } catch (e) { return ''; }
    }

    function formatDateTime(ms) {
      try {
        var d = new Date(ms);
        return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false });
      } catch (e) { return ''; }
    }

    /** Poll GET /ctx-refresh/state every POLL_MS; calls onData(snapshot). */
    function useRuntimeState(onData) {
      var dataRef = React.useRef(null);
      React.useEffect(() => {
        var stopped = false;
        var inFlight = false;
        var timer = null;
        var poll = () => {
          if (inFlight || stopped) return;
          inFlight = true;
          fetch(STATE_URL, { cache: 'no-store' })
            .then((res) => res.json().catch(() => null))
            .then((snap) => {
              inFlight = false;
              if (stopped || !snap || snap.ok !== true) return;
              dataRef.current = snap;
              onData(snap);
            })
            .catch(() => { inFlight = false; });
        };
        poll();
        timer = window.setInterval(poll, POLL_MS);
        return () => { stopped = true; if (timer !== null) window.clearInterval(timer); };
      }, []);
    }

    // ── settings card ──
    var STYLE_ID = 'dsh-ctx-refresh-settings-card-styles';
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = [
        '.zai-ctxr-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
        '.zai-ctxr-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
        '.zai-ctxr-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
        '.zai-ctxr-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
        '.zai-ctxr-header:focus-visible,.zai-ctxr-button:focus-visible,.zai-ctxr-checkbox:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.zai-ctxr-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
        '.zai-ctxr-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}',
        '.zai-ctxr-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
        '.zai-ctxr-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
        '.zai-ctxr-chevron-open{transform:rotate(180deg)}',
        '.zai-ctxr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
        '.zai-ctxr-field,.zai-ctxr-toggle-field{display:flex;gap:6px;padding:12px 0}',
        '.zai-ctxr-field{flex-direction:column}.zai-ctxr-toggle-field{align-items:flex-start;cursor:pointer}',
        '.zai-ctxr-field+.zai-ctxr-field,.zai-ctxr-field+.zai-ctxr-toggle-field,.zai-ctxr-toggle-field+.zai-ctxr-field,.zai-ctxr-toggle-field+.zai-ctxr-toggle-field{border-top:1px solid var(--dsw-alias-border-l2)}',
        '.zai-ctxr-toggle-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
        '.zai-ctxr-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.zai-ctxr-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
        '.zai-ctxr-checkbox{width:16px;height:16px;margin:2px 2px 0 0;accent-color:var(--dsw-alias-brand-primary)}',
        '.zai-ctxr-checkbox:disabled{cursor:default;opacity:.5}',
        '.zai-ctxr-input{width:96px;height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.zai-ctxr-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
        '.zai-ctxr-footer{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}',
        '.zai-ctxr-status{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);text-align:left}',
        '.zai-ctxr-status-error{color:var(--dsw-alias-state-error-primary)}',
        '.zai-ctxr-button{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
        '.zai-ctxr-button:disabled{opacity:.4;cursor:default}',
        // composer.dock ambient chip
        '.zai-ctxr-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 10px;border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
        '.zai-ctxr-chip-error{color:var(--dsw-alias-state-error-primary)}'
      ].join('\n');
      document.head.appendChild(style);
    }

    function SettingsCard(props) {
      var state = props.useCtxRefresh((snapshot) => snapshot);
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var phaseState = React.useState('idle'); // idle | sending | done | error
      var phase = phaseState[0];
      var setPhase = phaseState[1];
      var messageState = React.useState('');
      var message = messageState[0];
      var setMessage = messageState[1];
      var detailState = React.useState([]);
      var detail = detailState[0];
      var setDetail = detailState[1];
      var runtimeState = React.useState(null); // polled /ctx-refresh/state snapshot
      var runtime = runtimeState[0];
      var setRuntime = runtimeState[1];

      useRuntimeState(setRuntime);

      if (!state || state.available !== true) return null;
      var disabled = !state.writable;

      var numberField = (field, value) => {
        if (value.trim() === '') { props.clear(field); return; }
        var parsed = Number(value);
        if (Number.isFinite(parsed)) props.set(field, parsed);
      };

      var refreshNow = () => {
        if (phase === 'sending') return;
        setPhase('sending');
        setMessage('');
        setDetail([]);
        fetch(REFRESH_URL, { method: 'POST' })
          .then((res) => res.json().catch(() => null))
          .then((data) => {
            if (typeof console !== 'undefined') console.debug('[dsh-ctx-refresh]', data);
            if (!data || !data.ok) {
              setPhase('error');
              setMessage(String((data && data.message) || '刷新失败'));
              return;
            }
            var lines = [];
            for (var i = 0; i < data.updated.length; i++) {
              var u = data.updated[i];
              lines.push(u.model + ': ' + (u.from === null ? '—' : String(u.from)) + ' → ' + String(u.to) + '（' + u.source + '）');
            }
            for (var e = 0; e < data.errors.length; e++) {
              lines.push('✗ ' + data.errors[e].route + ': ' + data.errors[e].error);
            }
            for (var s = 0; s < data.skipped.length; s++) {
              lines.push('· 跳过 ' + data.skipped[s].route + ': ' + data.skipped[s].reason);
            }
            var parts = [];
            if (data.updated.length > 0) parts.push('已更新 ' + String(data.updated.length) + ' 个模型');
            if (data.unchangedModels > 0) parts.push(String(data.unchangedModels) + ' 个无变化');
            if (data.noWindowModels > 0) parts.push(String(data.noWindowModels) + ' 个未报告窗口');
            if (data.skipped.length > 0) parts.push('跳过 ' + String(data.skipped.length) + ' 条路由');
            if (data.errors.length > 0) parts.push(String(data.errors.length) + ' 条失败');
            var summary = parts.length > 0 ? parts.join(' · ') : '没有可刷新的模型';
            setPhase(data.updated.length === 0 && data.errors.length > 0 ? 'error' : 'done');
            setMessage(summary);
            setDetail(lines);
          })
          .catch((err) => {
            if (typeof console !== 'undefined') console.debug('[dsh-ctx-refresh] network error', err);
            setPhase('error');
            setMessage(String((err && err.message) || err));
          });
      };

      // Last-sync line: prefer the just-finished manual run, else polled runtime state.
      var lastLine = '';
      if (phase === 'done' || phase === 'error') {
        lastLine = message;
      } else if (runtime && runtime.lastResult) {
        var r = runtime.lastResult;
        var timePart = formatClock(r.atMs);
        lastLine = '上次同步 ' + timePart + ' · ' + formatResult(r);
      }

      return React.createElement('li', {
        className: 'zai-ctxr-card' + (open ? ' zai-ctxr-card-open' : '')
      }, [
        React.createElement('button', {
          type: 'button',
          key: 'header',
          className: 'zai-ctxr-header',
          'aria-expanded': open,
          onClick: () => setOpen(!open)
        }, [
          React.createElement('span', { key: 'text', className: 'zai-ctxr-head-text' }, [
            React.createElement('span', { key: 'name', className: 'zai-ctxr-name' }, '模型上下文同步'),
            React.createElement('span', { key: 'desc', className: 'zai-ctxr-description' }, '拉取各提供商实时模型列表并写回 contextWindow；发送消息时可自动同步')
          ]),
          React.createElement('svg', {
            key: 'chevron',
            className: 'zai-ctxr-chevron' + (open ? ' zai-ctxr-chevron-open' : ''),
            viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': 'true'
          }, React.createElement('path', { d: 'M3.5 5.5 7 9l3.5-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }))
        ]),
        open ? React.createElement('div', { key: 'body', className: 'zai-ctxr-body' }, [
          disabled ? React.createElement('p', { key: 'ro', className: 'zai-ctxr-hint' }, '当前设置不可写，仅可查看。') : null,
          // auto-sync toggle
          React.createElement('label', { key: 'toggle', className: 'zai-ctxr-toggle-field' }, [
            React.createElement('input', {
              type: 'checkbox',
              className: 'zai-ctxr-checkbox',
              checked: state.autoSyncEnabled === true,
              disabled: disabled,
              onChange: (e) => props.set('autoSyncEnabled', e.target.checked === true)
            }),
            React.createElement('span', { key: 'copy', className: 'zai-ctxr-toggle-copy' }, [
              React.createElement('span', { key: 'label', className: 'zai-ctxr-label' }, '自动同步'),
              React.createElement('span', { key: 'hint', className: 'zai-ctxr-hint' }, '每次发送消息时检查上次同步时间，超过间隔即在后台刷新一次')
            ])
          ]),
          // interval minutes
          React.createElement('div', { key: 'interval', className: 'zai-ctxr-field' }, [
            React.createElement('span', { key: 'label', className: 'zai-ctxr-label' }, '同步间隔（分钟）'),
            React.createElement('input', {
              type: 'number',
              min: 1,
              step: 5,
              className: 'zai-ctxr-input',
              value: String(state.intervalMinutes),
              disabled: disabled || state.autoSyncEnabled !== true,
              onChange: (e) => numberField('autoSyncIntervalMinutes', e.target.value)
            })
          ]),
          // footer: last-sync line + manual refresh button
          React.createElement('div', { key: 'footer', className: 'zai-ctxr-footer' }, [
            lastLine !== '' ? React.createElement('p', {
              key: 'status',
              className: 'zai-ctxr-status' + (phase === 'error' || (runtime && runtime.lastResult && runtime.lastResult.ok === false) ? ' zai-ctxr-status-error' : ''),
              title: detail.length > 0 ? detail.join('\n') : undefined
            }, lastLine) : null,
            React.createElement('button', {
              key: 'refresh',
              type: 'button',
              className: 'zai-ctxr-button',
              disabled: phase === 'sending' || (runtime && runtime.syncing === true),
              onClick: refreshNow,
              title: detail.length > 0 ? detail.join('\n') : '拉取各提供商模型列表，更新所有已配置模型的 contextWindow'
            }, phase === 'sending' ? '刷新中…' : '立即刷新')
          ])
        ]) : null
      ]);
    }

    // ── composer.dock ambient chip ──
    function DockChip() {
      var runtimeState = React.useState(null);
      var runtime = runtimeState[0];
      var setRuntime = runtimeState[1];
      useRuntimeState(setRuntime);

      if (!runtime) return null;
      if (runtime.syncing === true) {
        return React.createElement('span', { className: 'zai-ctxr-chip' }, [
          React.createElement('svg', { key: 'i', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, [
            React.createElement('path', { key: 'a', d: 'M15 3h6v6' }),
            React.createElement('path', { key: 'b', d: 'M9 21H3v-6' }),
            React.createElement('path', { key: 'c', d: 'M21 3l-7 7' }),
            React.createElement('path', { key: 'd', d: 'M3 21l7-7' })
          ]),
          '正在同步模型上下文…'
        ]);
      }
      var r = runtime.lastResult;
      if (r && typeof r === 'object' && Date.now() - Number(r.atMs || 0) < RESULT_VISIBLE_MS) {
        return React.createElement('span', {
          className: 'zai-ctxr-chip' + (r.ok === false ? ' zai-ctxr-chip-error' : ''),
          title: Array.isArray(r.errors) && r.errors.length > 0 ? r.errors.join('\n') : undefined
        }, [
          React.createElement('svg', { key: 'i', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, [
            React.createElement('path', { key: 'a', d: 'M15 3h6v6' }),
            React.createElement('path', { key: 'b', d: 'M9 21H3v-6' }),
            React.createElement('path', { key: 'c', d: 'M21 3l-7 7' }),
            React.createElement('path', { key: 'd', d: 'M3 21l7-7' })
          ]),
          formatResult(r) + (r.atMs ? '（' + formatClock(r.atMs) + '）' : '')
        ]);
      }
      return null;
    }

    // ── apply ──
    function apply(ctx) {
      ensureStyles();

      var scope = ctx.settingsScope.bind({ namespace: 'dsh-ctx-refresh' });
      var project = () => {
        var snap = scope.getSnapshot();
        var value = (snap && snap.value !== undefined && snap.value !== null) ? snap.value : {};
        return {
          available: snap.status === 'ready',
          writable: snap.writable,
          autoSyncEnabled: value.autoSyncEnabled === true,
          intervalMinutes: typeof value.autoSyncIntervalMinutes === 'number' ? value.autoSyncIntervalMinutes : 30
        };
      };
      var store = createSnapshotStore(project());
      ctx.effect(() => {
        var disposeSub = scope.subscribe(() => { store.set(project()); });
        return () => { if (typeof disposeSub === 'function') disposeSub(); };
      }, 'dsh-ctx-refresh: settings subscription');

      // Settings card (keyed by the served namespace dsh-ctx-refresh).
      ctx.effect(() => {
        var disposeSlot = ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'dsh-ctx-refresh',
          inject: () => ({
            hooks: { ctxRefresh: store },
            set: (field, value) => { scope.set(field, value); },
            clear: (field) => { scope.unset(field); }
          })
        }, SettingsCard));
        return () => disposeSlot();
      }, 'dsh-ctx-refresh: settings card');

      // Ambient sync readout under the composer.
      ctx.effect(() => {
        var disposeSlot = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'ctx-refresh-status',
          order: 10,
          label: () => '模型上下文同步状态'
        }, DockChip));
        return () => disposeSlot();
      }, 'dsh-ctx-refresh: composer dock chip');
    }

    module.exports = { name: 'dsh-ctx-refresh-client', apply: apply, inject: inject };
    return module.exports;
  }
});
