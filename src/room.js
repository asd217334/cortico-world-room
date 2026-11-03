/* 小房间前端 · 桌面比例版
   舞台宽度 = 屏幕宽度，电视 left = tvX * 100%。
   按住电视拖动，松手 POST /api/tv/position 写回配置，桌面电视同步挪过去。 */
(function () {
  const stage = document.getElementById('stage')
  const tv = document.getElementById('tv')
  const read = document.getElementById('read')
  const hud = document.getElementById('hud')
  const screenBtn = document.getElementById('screenBtn')

  const LABEL = {
    bed: '床', desk: '书桌', sofa: '沙发', window: '窗边', tv: '电视前', floor: '房间中间', read: '书架',
  }

  let tvX = 0.8
  let dragging = false
  let moved = false
  let startX = 0
  let saveTimer = 0

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function place(x) {
    tvX = Math.max(0, Math.min(1, x))
    tv.style.left = (tvX * 100).toFixed(3) + '%'
  }

  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      fetch('/api/tv/position', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: tvX }),
      }).catch(() => {})
    }, 120)
  }

  function fromEvent(e) {
    const r = stage.getBoundingClientRect()
    return (e.clientX - r.left) / Math.max(1, r.width)
  }

  tv.addEventListener('pointerdown', (e) => {
    dragging = true
    moved = false
    startX = e.clientX
    tv.classList.add('dragging')
    try { tv.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
    e.preventDefault()
  })

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return
    // 只有真的拖起来（超过 4px）才动位置，避免单击电视就跳走
    if (Math.abs(e.clientX - startX) > 4) moved = true
    if (moved) place(fromEvent(e))
  })

  window.addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    tv.classList.remove('dragging')
    if (moved) save()
  })

  document.addEventListener('dblclick', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.()
    else document.exitFullscreen?.()
  })

  async function poll() {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' })
      if (!r.ok) return
      const s = await r.json()
      if (!dragging && typeof s.tvX === 'number') place(s.tvX)
      tv.src = s.tv ? '/bg/furn-tv-on.png' : '/bg/furn-tv-off.png'
      // 电视大小/隐藏/镜像跟着配置走，跟桌面层保持一致
      if (typeof s.tvWidth === 'number') tv.style.width = s.tvWidth + '%'
      tv.style.visibility = s.tvHidden ? 'hidden' : 'visible'
      tv.style.transform = `translateX(-50%)${s.tvFlip ? ' scaleX(-1)' : ''}`
      // 书架：位置/大小读配置，灯亮灯灭换图，镜像与隐藏跟桌面层一致
      if (read) {
        if (typeof s.readX === 'number') {
          read.style.left = (Math.max(0, Math.min(1, s.readX)) * 100).toFixed(3) + '%'
        }
        if (typeof s.readWidth === 'number') read.style.width = s.readWidth + '%'
        read.style.transform = `translateX(-50%)${s.readFlip ? ' scaleX(-1)' : ''}`
        read.style.visibility = s.readHidden ? 'hidden' : 'visible'
        read.src = s.read ? '/bg/furn-read-on.png' : '/bg/furn-read-off.png'
      }
      hud.innerHTML = `<b>${esc(LABEL[s.slot] || s.slot)}</b> · ${esc(s.activity || '发呆')}`
      if (screenBtn) screenBtn.textContent = s.displayIndex >= 0 ? `屏幕 ${s.displayIndex}` : '主屏'
    } catch (e) { /* 下一轮再试 */ }
  }

  // 点一下就换到下一块显示器：桌面层的电视跟着过去
  if (screenBtn) {
    screenBtn.addEventListener('click', async () => {
      try {
        const r = await fetch('/api/tv/display/next', { method: 'POST' })
        const j = await r.json()
        screenBtn.textContent = j.index >= 0 ? `屏幕 ${j.index}` : '主屏'
      } catch (e) { /* 下一轮再试 */ }
    })
  }

  poll()
  setInterval(poll, 2000)
})()
