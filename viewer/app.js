'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const refs = Object.fromEntries([
    'connection-status', 'connection-text', 'refresh-button', 'logout-button', 'notice',
    'login-panel', 'login-description', 'login-instructions', 'workspace',
    'device-count', 'device-list', 'device-list-empty', 'create-form', 'template-select', 'create-button', 'template-hint',
    'screen-title', 'screen-subtitle', 'device-state', 'device-toolbar', 'start-button', 'stop-button', 'takeover-button', 'destroy-button',
    'live-toolbar', 'live-start-button', 'live-stop-button', 'live-audio-button', 'live-status', 'live-video',
    'screen-empty', 'empty-title', 'empty-description', 'phone-frame', 'screen-image', 'preview-status', 'control-hint',
    'back-button', 'home-button', 'enter-button', 'record-form', 'record-kind', 'record-duration', 'record-button', 'recording-list', 'recordings-empty',
  ].map(id => [id, $(id)]));
  const SESSION = /^m-[a-f0-9-]{36}$/;
  const RECORDING = /^[a-f0-9-]{36}$/;
  const ACTIVE = new Set(['starting', 'recording', 'stopping']);
  const labels = {stopped: '已停止', booting: '正在启动', running: '运行中', stopping: '正在停止', failed: '需要检查', interrupted: '需要恢复', starting: '准备录制', recording: '录制中', completed: '已完成'};
  let authenticated = false, busy = false, pollBusy = false, refreshQueued = false, templatesLoaded = false;
  let sessions = [], templates = [], recordings = [], selectedId = null, frame = null, revision = 0;
  let timer = null, captureController = null, unloaded = false, live = null, closingLive = false;
  const selected = () => sessions.find(item => item.id === selectedId);
  const stateLabel = value => labels[value] || '未知状态';
  const freshFrame = () => !!frame && frame.sessionId === selectedId && Date.now() - frame.receivedAt < 8000;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function notice(message = '', kind = '') {
    refs.notice.hidden = !message;
    refs.notice.textContent = String(message).slice(0, 500);
    refs.notice.className = `notice ${kind}`;
  }

  function invalidateFrame({clearImage = false} = {}) {
    frame = null;
    captureController?.abort();
    captureController = null;
    if (clearImage) {
      refs['screen-image'].removeAttribute('src');
      refs['phone-frame'].hidden = true;
      refs['screen-empty'].hidden = false;
    }
    updateControls();
  }

  function clearRecordings() {
    for (const audio of refs['recording-list'].querySelectorAll('audio')) {
      audio.pause(); audio.removeAttribute('src'); audio.load();
    }
    recordings = [];
    refs['recording-list'].replaceChildren();
    refs['recordings-empty'].hidden = false;
  }

  function setAuthenticated(value) {
    authenticated = value;
    refs['login-panel'].hidden = value;
    refs.workspace.hidden = !value;
    refs['logout-button'].hidden = !value;
    refs['refresh-button'].hidden = !value;
    refs['connection-status'].classList.toggle('connected', value);
    refs['connection-text'].textContent = value ? '本地服务已连接' : '等待本地登录';
    if (!value) {
      void closeLive();
      clearTimeout(timer); revision++;
      sessions = []; selectedId = null;
      invalidateFrame({clearImage: true}); clearRecordings();
      refs['login-description'].textContent = '先在这台电脑上授权，再查看和控制虚拟设备。';
      refs['login-instructions'].hidden = false;
    }
  }

  async function api(route, {method = 'GET', body, signal, timeout = 20000, keepalive = false} = {}) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const response = await fetch(route, {
      method, credentials: 'same-origin', redirect: 'error', cache: 'no-store', keepalive,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      headers: body === undefined ? {} : {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let value;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) {
      if (response.status === 401) setAuthenticated(false);
      const error = new Error(value?.error?.message || '请求未完成，请检查本地服务。');
      error.status = response.status; error.code = value?.error?.code;
      throw error;
    }
    return value;
  }

  const action = (id, name, args = {}, options = {}) => api(`/v1/admin/sessions/${id}/action`, {
    method: 'POST', body: {action: name, args}, timeout: name === 'start' ? 650000 : 30000, ...options,
  });

  const livePath = current => `/v1/admin/sessions/${current.sessionId}/live`;

  async function closeLive() {
    const current = live;
    if (!current) return;
    // Release local media synchronously, even when the server cannot be reached.
    live = null; closingLive = true;
    clearTimeout(current.renewTimer); clearTimeout(current.expiryTimer); clearTimeout(current.connectTimer);
    current.controller.abort();
    current.peer.ontrack = null;
    current.peer.onconnectionstatechange = null;
    current.peer.oniceconnectionstatechange = null;
    current.peer.close();
    for (const track of current.stream.getTracks()) track.stop();
    refs['live-video'].removeEventListener('loadeddata', current.videoReady);
    refs['live-video'].removeEventListener('playing', current.videoReady);
    refs['live-video'].pause(); refs['live-video'].srcObject = null;
    refs['live-video'].muted = true; refs['live-video'].hidden = true;
    refs['screen-image'].hidden = false;
    if (!refs['screen-image'].hasAttribute('src')) {
      refs['phone-frame'].hidden = true; refs['screen-empty'].hidden = false;
    }
    refs['preview-status'].textContent = '截图预览 · 每 2 秒刷新';
    updateControls();
    if (current.leaseId) {
      try {
        await api(`${livePath(current)}/${current.leaseId}/close`, {method: 'POST', body: {}, timeout: 2000, keepalive: true});
      } catch { /* A lease expiry remains the server-side cleanup fallback. */ }
    }
    closingLive = false; updateControls();
    if (authenticated && !busy && !document.hidden && !unloaded) requestRefresh();
  }

  function waitForCompleteIce(peer, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', changed);
        signal.removeEventListener('abort', aborted);
      };
      const changed = () => { if (peer.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const aborted = () => { cleanup(); reject(new DOMException('Preview closed', 'AbortError')); };
      peer.addEventListener('icegatheringstatechange', changed);
      signal.addEventListener('abort', aborted, {once: true});
      timer = setTimeout(() => { cleanup(); reject(new Error('ICE gathering timed out')); }, 10000);
      if (signal.aborted) aborted(); else changed();
    });
  }

  function updateLiveExpiry(current, result) {
    const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
    const expires = timestamp(result?.expiresAt);
    const hard = result?.hardExpiresAt === undefined ? current.hardExpiresAt : timestamp(result.hardExpiresAt);
    if (!Number.isFinite(expires) || !Number.isFinite(hard)) throw new Error('Invalid preview lease');
    current.hardExpiresAt = current.hardExpiresAt ? Math.min(current.hardExpiresAt, hard) : hard;
    current.expiresAt = Math.min(expires, current.hardExpiresAt);
    if (current.expiresAt <= Date.now()) throw new Error('Preview lease expired');
    clearTimeout(current.expiryTimer);
    current.expiryTimer = setTimeout(() => {
      if (live !== current) return;
      void closeLive();
      notice('实时预览已到期，已切回截图。需要时请重新点击“实时预览”。');
    }, Math.min(current.expiresAt - Date.now(), 2147483647));
  }

  function scheduleLiveRenewal(current) {
    clearTimeout(current.renewTimer);
    current.renewTimer = setTimeout(async () => {
      if (live !== current || document.hidden || !authenticated) { if (live === current) void closeLive(); return; }
      try {
        const result = await api(`${livePath(current)}/${current.leaseId}/renew`, {method: 'POST', body: {}, signal: current.controller.signal, timeout: 5000});
        if (live !== current) return;
        updateLiveExpiry(current, result);
        scheduleLiveRenewal(current);
      } catch {
        if (live !== current) return;
        void closeLive();
        if (authenticated) notice('实时预览续期未完成，连接已关闭。截图预览会继续刷新。');
      }
    }, 10000);
  }

  async function startLive() {
    const device = selected();
    if (busy || live || closingLive || !authenticated || document.hidden || device?.state !== 'running' || !device.capabilities?.realtimeMedia) return;
    if (typeof RTCPeerConnection !== 'function') { notice('此浏览器不支持实时预览，请继续使用截图预览。'); return; }
    busy = true; revision++; clearTimeout(timer); invalidateFrame();
    let current;
    try {
      // This peer receives media only: no microphone/camera access, ICE servers,
      // client-selected destination, or data channel carrying device input.
      const peer = new RTCPeerConnection({iceServers: [], bundlePolicy: 'max-bundle'});
      current = {sessionId: device.id, takeover: !!device.takeover, peer, stream: new MediaStream(), controller: new AbortController(), hasVideo: false};
      live = current;
      refs['live-video'].muted = true;
      refs['live-status'].textContent = '正在连接本机实时画面…';
      updateControls();
      current.videoReady = () => {
        if (live !== current || !refs['live-video'].videoWidth) return;
        current.hasVideo = true; clearTimeout(current.connectTimer);
        refs['live-video'].hidden = false; refs['screen-image'].hidden = true;
        refs['phone-frame'].hidden = false; refs['screen-empty'].hidden = true;
        refs['live-status'].textContent = '本机实时预览 · 只接收画面与声音';
        refs['preview-status'].textContent = '实时预览 · 操作仍由新鲜截图确认';
        updateControls();
      };
      refs['live-video'].addEventListener('loadeddata', current.videoReady);
      refs['live-video'].addEventListener('playing', current.videoReady);
      peer.ontrack = event => {
        if (live !== current) { event.track.stop(); return; }
        if (!current.stream.getTracks().includes(event.track)) current.stream.addTrack(event.track);
        event.track.addEventListener('ended', () => {
          if (live !== current) return;
          void closeLive(); notice('实时媒体已结束，已切回截图预览。');
        }, {once: true});
        refs['live-video'].srcObject = current.stream;
        void refs['live-video'].play().catch(() => {
          if (live === current) notice('浏览器没有开始播放实时画面。可以关闭后重新点击“实时预览”。');
        });
        updateControls();
      };
      const connectionChanged = () => {
        if (live !== current) return;
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState) || ['failed', 'disconnected', 'closed'].includes(peer.iceConnectionState)) {
          void closeLive(); notice('实时连接已中断，已切回截图。不会自动重新连接。');
        }
      };
      peer.onconnectionstatechange = connectionChanged;
      peer.oniceconnectionstatechange = connectionChanged;
      peer.addTransceiver('video', {direction: 'recvonly'});
      peer.addTransceiver('audio', {direction: 'recvonly'});
      await peer.setLocalDescription(await peer.createOffer());
      await waitForCompleteIce(peer, current.controller.signal);
      if (live !== current || current.controller.signal.aborted) return;
      const result = await api(livePath(current), {method: 'POST', body: {offer: peer.localDescription.sdp}, signal: current.controller.signal, timeout: 15000});
      if (typeof result?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.id)) current.leaseId = result.id;
      if (live !== current || current.controller.signal.aborted) {
        // A response may have arrived just as the local peer was cancelled.
        if (current.leaseId) void api(`${livePath(current)}/${current.leaseId}/close`, {method: 'POST', body: {}, timeout: 2000, keepalive: true}).catch(() => {});
        return;
      }
      if (!current.leaseId || result.mode !== 'local-media-only' || result.answer?.type !== 'answer' || typeof result.answer.sdp !== 'string' || result.answer.sdp.length > 200000) throw new Error('Invalid local media answer');
      updateLiveExpiry(current, result);
      await peer.setRemoteDescription({type: 'answer', sdp: result.answer.sdp});
      if (live !== current) return;
      scheduleLiveRenewal(current);
      current.connectTimer = setTimeout(() => {
        if (live !== current || current.hasVideo) return;
        void closeLive(); notice('没有收到实时画面，已关闭连接。请继续使用截图预览。');
      }, 15000);
    } catch {
      if (live === current) {
        await closeLive();
        if (authenticated) notice('实时预览没有建立，继续使用截图预览。请检查本机媒体服务。', 'error');
      }
    } finally {
      busy = false; updateControls(); requestRefresh();
    }
  }

  refs['live-start-button'].addEventListener('click', () => { void startLive(); });
  refs['live-stop-button'].addEventListener('click', () => { void closeLive(); });
  refs['live-audio-button'].addEventListener('click', () => {
    if (!live?.hasVideo) return;
    const current = live;
    refs['live-video'].muted = !refs['live-video'].muted;
    void refs['live-video'].play().catch(() => {
      if (live !== current) return;
      refs['live-video'].muted = true; updateControls();
      notice('浏览器未能播放声音，请再次点击“打开声音”。');
    });
    updateControls();
  });

  function updateControls() {
    const device = selected();
    const running = device?.state === 'running';
    const manual = running && device.takeover && freshFrame() && !busy;
    refs['create-button'].disabled = busy || !refs['template-select'].value;
    refs['template-select'].disabled = busy || !templates.some(item => item.available);
    refs['refresh-button'].disabled = busy;
    refs['start-button'].disabled = busy || !device || running || device.recoveryRequired;
    refs['stop-button'].disabled = busy || !device || device.state === 'stopped';
    refs['takeover-button'].disabled = busy || !device;
    refs['takeover-button'].textContent = device?.takeover ? '交还 Agent' : '接管设备';
    refs['destroy-button'].disabled = busy || !device;
    refs['live-toolbar'].hidden = !device;
    refs['live-start-button'].hidden = !!live;
    refs['live-start-button'].disabled = busy || closingLive || !running || !device?.capabilities?.realtimeMedia || typeof RTCPeerConnection !== 'function';
    refs['live-stop-button'].hidden = !live;
    refs['live-audio-button'].hidden = !live;
    refs['live-audio-button'].disabled = !live?.hasVideo || !live?.stream?.getAudioTracks().some(track => track.readyState === 'live');
    refs['live-audio-button'].textContent = refs['live-video'].muted ? '打开声音' : '静音';
    refs['live-toolbar'].classList.toggle('active', !!live?.hasVideo);
    if (closingLive) refs['live-status'].textContent = '正在关闭本机实时连接…';
    else if (!live) refs['live-status'].textContent = device?.capabilities?.realtimeMedia
      ? '本机实时通道 · 只接收画面与声音'
      : '未配置实时通道，当前使用截图预览。';
    for (const id of ['back-button', 'home-button', 'enter-button']) refs[id].disabled = !manual;
    refs['phone-frame'].classList.toggle('interactive', !!manual);
    refs['control-hint'].classList.toggle('active', !!device?.takeover);
    refs['control-hint'].textContent = device?.takeover
      ? '你正在接管 · Agent 已暂停。点击画面或使用导航按钮；每次操作后重新获取画面。'
      : '接管后可点击画面；Agent 会暂停观察和操作。';
    refs['record-button'].disabled = busy || !running || recordings.some(item => ACTIVE.has(item.state));
    refs['record-kind'].disabled = busy;
    refs['record-duration'].disabled = busy;
    for (const button of refs['device-list'].querySelectorAll('button')) button.disabled = busy;
    for (const button of refs['recording-list'].querySelectorAll('button[data-mutation]')) button.disabled = busy;
  }

  function renderTemplates() {
    const prior = refs['template-select'].value;
    refs['template-select'].replaceChildren();
    const available = templates.filter(item => item.available && typeof item.name === 'string');
    if (!available.length) {
      const option = element('option', '', '没有可用模板'); option.value = '';
      refs['template-select'].append(option);
      refs['template-hint'].textContent = '先安装 Android SDK 并配置干净的 AVD 模板。这里不会自动连接你的手机。';
    } else {
      for (const template of available) {
        const option = element('option', '', template.name); option.value = template.name;
        refs['template-select'].append(option);
      }
      if (available.some(item => item.name === prior)) refs['template-select'].value = prior;
      refs['template-hint'].textContent = '创建后可以启动设备并查看画面。';
    }
    updateControls();
  }

  function renderSessions() {
    refs['device-count'].textContent = sessions.length;
    refs['device-list-empty'].hidden = sessions.length > 0;
    refs['device-list'].replaceChildren();
    for (const [index, device] of sessions.entries()) {
      const button = element('button', 'device'); button.type = 'button';
      button.setAttribute('aria-pressed', String(device.id === selectedId));
      const icon = element('span', 'device-symbol'); icon.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'device-copy');
      copy.append(element('span', 'device-name', `虚拟手机 ${index + 1}`), element('span', 'device-detail', `${device.template} · ${device.id.slice(2, 10)}`));
      const dot = element('span', 'device-status'); dot.dataset.state = device.state; dot.title = stateLabel(device.state);
      button.append(icon, copy, dot);
      button.addEventListener('click', () => selectDevice(device.id));
      refs['device-list'].append(button);
    }
    const device = selected();
    if (live && (!device || device.id !== live.sessionId || device.state !== 'running' || !!device.takeover !== live.takeover || !device.capabilities?.realtimeMedia)) void closeLive();
    refs['device-toolbar'].hidden = !device;
    refs['device-state'].hidden = !device;
    refs['screen-title'].textContent = device ? `虚拟手机 ${sessions.findIndex(item => item.id === device.id) + 1}` : '设备画面';
    refs['screen-subtitle'].textContent = device ? `${device.template} · ${device.id.slice(2, 10)}` : '选择或创建一台虚拟手机';
    if (device) {
      refs['device-state'].textContent = stateLabel(device.state); refs['device-state'].dataset.state = device.state;
      if (device.state !== 'running') {
        invalidateFrame({clearImage: true});
        refs['empty-title'].textContent = device.recoveryRequired ? '这台设备需要恢复' : device.state === 'booting' ? '正在启动 Android' : '设备尚未运行';
        refs['empty-description'].textContent = device.recoveryRequired
          ? '上次运行没有正常结束，请先停止并检查设备状态，再启动或销毁。'
          : device.state === 'booting' ? '启动完成后，画面会显示在这里。' : '点击“启动”，即可查看这台独立虚拟手机的画面。';
      }
    } else {
      invalidateFrame({clearImage: true});
      refs['empty-title'].textContent = '一台专门为任务准备的手机';
      refs['empty-description'].textContent = '创建独立的 Android 虚拟设备，在这里查看 Agent 的操作。';
    }
    updateControls();
  }

  async function selectDevice(id) {
    if (busy || id === selectedId) return;
    busy = true;
    const version = ++revision;
    clearTimeout(timer); invalidateFrame(); updateControls();
    try {
      await closeLive();
      if (!authenticated || version !== revision) return;
      selectedId = id;
      invalidateFrame({clearImage: true}); clearRecordings(); renderSessions();
      refs['preview-status'].textContent = '正在获取设备画面…';
    } finally { busy = false; updateControls(); requestRefresh(); }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderRecordings() {
    // Preserve a user-started audio player across ordinary metadata polling.
    const playing = new Map([...refs['recording-list'].querySelectorAll('audio')].map(audio => [audio.dataset.recordingId, audio]));
    refs['recording-list'].replaceChildren();
    refs['recordings-empty'].hidden = recordings.length > 0;
    for (const record of recordings) {
      const box = element('div', 'recording');
      const top = element('div', 'recording-top');
      const status = element('span', 'recording-state', stateLabel(record.state)); status.dataset.state = record.state;
      top.append(element('span', 'recording-title', record.kind === 'audio' ? '内部音频' : '画面与声音'), status);
      const time = Number.isFinite(Date.parse(record.startedAt)) ? new Date(record.startedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '';
      box.append(top, element('p', 'recording-meta', [time, formatBytes(record.bytes)].filter(Boolean).join(' · ')));
      const actions = element('div', 'recording-actions');
      if (ACTIVE.has(record.state)) {
        const stop = element('button', 'button', record.state === 'stopping' ? '正在结束…' : '结束录制');
        stop.type = 'button'; stop.dataset.mutation = 'true'; stop.disabled = record.state === 'stopping' || busy;
        stop.addEventListener('click', () => mutate('正在结束录制…', id => action(id, 'recording_stop', {recordingId: record.id})));
        actions.append(stop);
      } else if (record.state === 'completed') {
        const url = `/v1/admin/sessions/${selectedId}/artifacts/${record.id}`;
        const download = element('a', 'button', record.kind === 'audio' ? '下载音频' : '下载 MKV');
        download.href = url; download.download = `${record.id}.${record.kind === 'audio' ? 'opus' : 'mkv'}`;
        actions.append(download);
        if (record.kind === 'audio') {
          const listen = element('button', 'button', '试听'); listen.type = 'button';
          listen.addEventListener('click', () => {
            let audio = box.querySelector('audio');
            if (!audio) {
              audio = element('audio'); audio.controls = true; audio.preload = 'none'; audio.src = url; audio.dataset.recordingId = record.id; box.append(audio);
              audio.addEventListener('error', () => notice('浏览器无法播放此录音，可以下载后使用音频播放器打开。'));
            }
            void audio.play().catch(() => notice('未能开始播放，可以使用音频控件或下载后播放。'));
          });
          actions.append(listen);
        }
        box.append(element('p', 'recording-meta', record.validation === 'audio-track-verified' ? '已验证媒体轨道' : '已检查文件格式'));
      } else if (record.state === 'failed') box.append(element('p', 'recording-meta', '录制未完成。请检查设备和采集工具后重新录制。'));
      if (actions.childElementCount) box.append(actions);
      if (playing.has(record.id)) box.append(playing.get(record.id));
      refs['recording-list'].append(box);
    }
    for (const [id, audio] of playing) if (!recordings.some(record => record.id === id)) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    updateControls();
  }

  async function capture(id, version) {
    if (document.hidden || busy || selected()?.state !== 'running') return;
    const controller = new AbortController(); captureController = controller;
    try {
      const result = await action(id, 'screenshot', {}, {signal: controller.signal, timeout: 20000});
      if (revision !== version || selectedId !== id || busy || document.hidden || !authenticated) return;
      if (result?.mime !== 'image/png' || typeof result.data !== 'string' || result.data.length > 24 * 1024 * 1024 || !Number.isInteger(result.width) || !Number.isInteger(result.height) || typeof result.frameId !== 'string') throw new Error('截图数据不可用。');
      const candidate = new Image(); candidate.src = `data:image/png;base64,${result.data}`;
      await candidate.decode();
      if (revision !== version || selectedId !== id || busy || document.hidden || !authenticated) return;
      refs['screen-image'].src = candidate.src;
      refs['screen-image'].width = result.width; refs['screen-image'].height = result.height;
      refs['phone-frame'].hidden = false; refs['screen-empty'].hidden = true;
      refs['screen-image'].hidden = !!live?.hasVideo;
      frame = {id: result.frameId, sessionId: id, width: result.width, height: result.height, receivedAt: Date.now()};
      refs['preview-status'].textContent = `${live?.hasVideo ? '实时预览 · 操作参考截图' : '截图预览'} · ${new Date().toLocaleTimeString('zh-CN')} 更新`;
      updateControls();
    } catch (error) {
      if (controller.signal.aborted || revision !== version || selectedId !== id || !authenticated) return;
      frame = null; updateControls();
      refs['preview-status'].textContent = '画面更新失败 · 将重新获取';
      if (refs['phone-frame'].hidden) {
        refs['empty-title'].textContent = '暂时无法获取画面';
        refs['empty-description'].textContent = '请确认 Android SDK 和模拟器可用。你可以刷新，或先停止设备后检查。';
      }
    } finally { if (captureController === controller) captureController = null; }
  }

  function schedule() {
    clearTimeout(timer);
    if (authenticated && !document.hidden && !unloaded) timer = setTimeout(refresh, 2000);
  }

  function requestRefresh({templates: reloadTemplates = false} = {}) {
    if (reloadTemplates) templatesLoaded = false;
    clearTimeout(timer);
    if (pollBusy || busy) { refreshQueued = true; return; }
    void refresh();
  }

  async function refresh() {
    if (pollBusy || busy || !authenticated || document.hidden || unloaded) return;
    pollBusy = true; refreshQueued = false;
    const version = revision;
    try {
      const [data, inventory] = await Promise.all([
        api('/v1/admin/sessions'),
        templatesLoaded ? Promise.resolve(null) : api('/v1/admin/templates'),
      ]);
      if (!authenticated || version !== revision || busy) return;
      if (!Array.isArray(data)) throw new Error('服务返回的设备列表无效。');
      sessions = data.filter(item => item && SESSION.test(item.id));
      if (Array.isArray(inventory)) { templates = inventory; templatesLoaded = true; renderTemplates(); }
      if (!sessions.some(item => item.id === selectedId)) {
        selectedId = sessions[0]?.id || null;
        invalidateFrame({clearImage: true}); clearRecordings();
      }
      renderSessions();
      const id = selectedId;
      if (id) {
        const records = await action(id, 'recording_list');
        if (!authenticated || version !== revision || selectedId !== id || busy) return;
        recordings = Array.isArray(records) ? records.filter(item => item && RECORDING.test(item.id)) : [];
        renderRecordings();
        await capture(id, version);
      } else refs['preview-status'].textContent = '截图预览 · 每 2 秒刷新';
      refs['connection-text'].textContent = '本地服务已连接';
    } catch (error) {
      if (authenticated && version === revision) {
        refs['connection-text'].textContent = '连接暂时中断';
        refs['preview-status'].textContent = '连接未完成 · 将重新获取状态';
        invalidateFrame();
      }
    } finally {
      pollBusy = false;
      if (refreshQueued && authenticated && !busy && !document.hidden) { refreshQueued = false; queueMicrotask(refresh); }
      else schedule();
    }
  }

  async function mutate(message, work, {requireDevice = true, closePreview = false} = {}) {
    if (busy || !authenticated || (requireDevice && !selectedId)) return;
    const id = selectedId;
    busy = true; revision++; clearTimeout(timer); invalidateFrame(); updateControls(); notice(message);
    try {
      if (closePreview) await closeLive();
      const result = await work(id);
      notice('操作已完成。', 'success');
      return result;
    } catch (error) {
      if (authenticated) notice(`${error.message} 操作没有自动重试，请先确认设备状态。`, 'error');
      return null;
    } finally {
      busy = false; updateControls(); requestRefresh();
    }
  }

  function consumeInput() {
    if (busy || !selected()?.takeover || selected()?.state !== 'running') return null;
    if (!freshFrame()) { invalidateFrame(); notice('画面已过期。请等待新画面，再确认并操作。'); requestRefresh(); return null; }
    const snapshot = {...frame};
    // Input is bound to the displayed screenshot and consumed before dispatch.
    frame = null;
    return snapshot;
  }

  function pointerInput(event) {
    const target = event.currentTarget;
    const box = target.getBoundingClientRect();
    const snapshot = consumeInput();
    if (!snapshot || box.width <= 0 || box.height <= 0) return;
    // Video can be letterboxed; normalize only its visible image area, then map
    // to the dimensions of the fresh HTTP screenshot reference.
    let left = box.left, top = box.top, width = box.width, height = box.height;
    if (target === refs['live-video']) {
      if (!live?.hasVideo || !target.videoWidth || !target.videoHeight) return;
      const scale = Math.min(box.width / target.videoWidth, box.height / target.videoHeight);
      width = target.videoWidth * scale; height = target.videoHeight * scale;
      left += (box.width - width) / 2; top += (box.height - height) / 2;
      if (event.clientX < left || event.clientX >= left + width || event.clientY < top || event.clientY >= top + height) return;
    }
    const x = Math.min(snapshot.width - 1, Math.max(0, Math.floor((event.clientX - left) * snapshot.width / width)));
    const y = Math.min(snapshot.height - 1, Math.max(0, Math.floor((event.clientY - top) * snapshot.height / height)));
    void mutate('正在发送点击…', id => action(id, 'tap', {x, y, frameId: snapshot.id}));
  }
  refs['screen-image'].addEventListener('click', pointerInput);
  refs['live-video'].addEventListener('click', pointerInput);
  for (const [id, key] of [['back-button', 'BACK'], ['home-button', 'HOME'], ['enter-button', 'ENTER']]) {
    refs[id].addEventListener('click', () => {
      const snapshot = consumeInput();
      if (snapshot) void mutate('正在发送按键…', selectedID => action(selectedID, 'key', {key, frameId: snapshot.id}));
    });
  }
  refs['create-form'].addEventListener('submit', event => {
    event.preventDefault();
    const template = refs['template-select'].value;
    if (!template) return;
    void mutate('正在创建独立设备…', async () => {
      const result = await api('/v1/admin/sessions', {method: 'POST', body: {template}, timeout: 650000});
      if (SESSION.test(result?.id)) { selectedId = result.id; clearRecordings(); invalidateFrame({clearImage: true}); }
      // The node-only credentialFile in the creation result is never displayed.
    }, {requireDevice: false});
  });
  refs['template-select'].addEventListener('change', updateControls);
  refs['start-button'].addEventListener('click', () => { void mutate('正在启动 Android，请稍候…', id => action(id, 'start')); });
  refs['stop-button'].addEventListener('click', () => { void mutate('正在停止设备和录制…', id => action(id, 'stop'), {closePreview: true}); });
  refs['takeover-button'].addEventListener('click', () => {
    const releasing = selected()?.takeover;
    void mutate(releasing ? '正在交还 Agent…' : '正在结束录制并接管设备…', id => action(id, releasing ? 'release' : 'takeover'), {closePreview: true});
  });
  refs['destroy-button'].addEventListener('click', () => {
    if (!selectedId || !window.confirm('销毁这台虚拟手机？其中的应用、登录状态和录制文件都会删除。')) return;
    void mutate('正在停止并销毁设备…', id => api(`/v1/admin/sessions/${id}`, {method: 'DELETE', timeout: 120000}), {closePreview: true});
  });
  refs['record-form'].addEventListener('submit', event => {
    event.preventDefault();
    if (!refs['record-form'].reportValidity()) return;
    const kind = refs['record-kind'].value, durationSec = Number(refs['record-duration'].value);
    void mutate('正在开始录制…', id => action(id, 'recording_start', {kind, durationSec}));
  });
  refs['refresh-button'].addEventListener('click', () => { notice(); requestRefresh({templates: true}); });
  refs['logout-button'].addEventListener('click', async () => {
    await closeLive();
    try { await api('/viewer/logout', {method: 'POST', body: {}}); notice(); }
    catch { notice('未能确认服务端退出。当前页面已隐藏设备内容，请检查本地服务。', 'error'); }
    finally { setAuthenticated(false); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      void closeLive();
      clearTimeout(timer); revision++; invalidateFrame();
      for (const audio of refs['recording-list'].querySelectorAll('audio')) audio.pause();
    } else requestRefresh();
  });
  window.addEventListener('pagehide', () => {
    void closeLive();
    unloaded = true; clearTimeout(timer); revision++; invalidateFrame({clearImage: true}); clearRecordings();
  });
  window.addEventListener('pageshow', () => { if (unloaded) { unloaded = false; requestRefresh(); } });

  async function initialize() {
    // Remove the one-time code before any request, rendering or asynchronous work.
    const fragment = location.hash;
    if (fragment) history.replaceState(null, '', location.pathname + location.search);
    try {
      const code = new URLSearchParams(fragment.slice(1)).get('code');
      if (code) await api('/viewer/login', {method: 'POST', body: {code}});
      // Probe only the protected endpoint, never infer login from page access.
      const data = await api('/v1/admin/sessions');
      if (!Array.isArray(data)) throw new Error('服务返回的设备列表无效。');
      setAuthenticated(true);
      await refresh();
    } catch (error) {
      setAuthenticated(false);
      if (error.status !== 401) notice('暂时无法连接本地服务。请确认服务已启动，再从操作员终端打开控制台。', 'error');
      else if (fragment) notice('登录链接已失效或已使用，请在终端重新执行 open。');
    }
  }

  void initialize();
})();
