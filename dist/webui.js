/**
 * 小房间 WebUI 客户端 v11：「拖动家具」堆叠式面板。
 *
 * 与 v10 的区别：
 *   - 状态文案改为读家具的 status 字段：书架显示「在看 / 空着」，电视仍显示「开着 / 关着」。
 *   - 命名统一：家具/位置叫「书架」（原「阅读角」），动作叫「看书」。
 *
 * 结构同 v10：去掉顶部「电视 / 书架」标签页，控制项纵向堆叠——
 * 电视一行在上，书架一行在它下面，各自显示状态、大小、以及自己的能力按钮。
 *
 * 注意：dist 下的脚本是 immutable 缓存，改内容必须换文件名，否则浏览器永不重新请求。
 */
const panel = {
  mount(ctx) {
    const root = ctx.root

    // ── 舞台 ──
    const wrap = document.createElement('div')
    wrap.style.cssText = [
      'position:relative',
      'width:100%',
      'height:210px',
      'border-radius:10px',
      'overflow:hidden',
      'background-color:#10151C',
      'background-image:radial-gradient(#232B37 1.2px, transparent 1.3px)',
      'background-size:22px 22px',
      'user-select:none',
    ].join(';')

    const hud = document.createElement('div')
    hud.style.cssText = [
      'position:absolute',
      'left:12px',
      'top:12px',
      'padding:6px 10px',
      'border-radius:999px',
      'background:rgba(21,26,34,.86)',
      'border:1px solid #252C37',
      'color:#E9EDF2',
      'font:12px system-ui',
      'pointer-events:none',
      'z-index:99',
    ].join(';')
    hud.textContent = '加载中…'
    wrap.appendChild(hud)

    // ── 控制区：每件家具一行，按 state.furniture 顺序纵向堆叠 ──
    const rows = document.createElement('div')
    rows.style.cssText = ['display:flex', 'flex-direction:column', 'gap:8px', 'margin-top:10px'].join(';')

    root.appendChild(wrap)
    root.appendChild(rows)

    const btn = (text) => {
      const b = document.createElement('button')
      b.textContent = text
      b.style.cssText = [
        'padding:5px 12px',
        'border-radius:999px',
        'border:1px solid #252C37',
        'background:rgba(21,26,34,.86)',
        'color:#E9EDF2',
        'font:12px system-ui',
        'cursor:pointer',
        'white-space:nowrap',
      ].join(';')
      return b
    }

    const els = new Map()      // id -> <img>
    const specs = new Map()    // id -> 家具状态（来自 state.furniture）
    const rowRefs = new Map()  // id -> 该行控件引用
    const busySlider = new Set() // 正在拖的滑杆：轮询别回写，免得抢手
    let images = {}            // id -> { off, on } base64
    let imagesReady = false
    let rowKey = ''
    let drag = null            // { id, startX, moved }

    const specOf = (id) => specs.get(id)

    const stateWord = (spec) => {
      if (spec.status) return spec.on ? spec.status.on : spec.status.off
      if (spec.caps.power) return spec.on ? '开着' : '关着'
      return spec.on ? '亮着' : '灭着'
    }

    /** 换图：开着用 on 图，关着用 off 图；隐藏的在面板里半透明，方便再拖回来。 */
    const paint = (spec) => {
      const el = els.get(spec.id)
      if (!el) return
      el.style.opacity = spec.hidden ? '0.25' : '1'
      if (!imagesReady) return
      const pair = images[spec.id]
      if (!pair) return
      const kind = spec.on ? 'on' : 'off'
      if (el.dataset.kind !== kind) {
        el.dataset.kind = kind
        el.src = pair[kind] || pair.off
      }
    }

    const place = (spec, z) => {
      const el = els.get(spec.id)
      if (!el) return
      el.style.left = (spec.x * 100).toFixed(2) + '%'
      el.style.width = spec.width + '%'
      el.style.zIndex = String(z)
      el.style.transform = `translateX(-50%)${spec.flip ? ' scaleX(-1)' : ''}`
      paint(spec)
    }

    /** 本地先反映一下，下一次轮询再用服务端状态校准。 */
    const invokeSet = (method, id, value) => {
      Promise.resolve()
        .then(() => ctx.invoke(method, [id, value]))
        .catch(() => {})
      const spec = specOf(id)
      if (!spec) return
      if (method === 'setPower') spec.on = !!value
      if (method === 'setHidden') spec.hidden = !!value
      if (method === 'setFlip') spec.flip = !!value
      if (method === 'setSize') spec.width = Number(value)
      place(spec, [...specs.keys()].indexOf(id) + 10)
      syncRow(spec)
    }

    /** 一行：名称+状态 / 大小滑杆 / 开关 / 隐藏 / 镜像（按 caps 决定有哪些）。 */
    const buildRow = (spec) => {
      const row = document.createElement('div')
      row.style.cssText = [
        'display:flex',
        'align-items:center',
        'flex-wrap:wrap',
        'gap:10px',
        'padding:8px 10px',
        'border-radius:10px',
        'border:1px solid #252C37',
        'background:rgba(21,26,34,.5)',
        'font:12px system-ui',
        'color:#E9EDF2',
      ].join(';')

      const name = document.createElement('span')
      name.style.cssText = ['min-width:118px', 'font-weight:600', 'white-space:nowrap'].join(';')
      row.appendChild(name)

      const refs = { row, name }

      if (spec.caps.resize) {
        const slider = document.createElement('input')
        slider.type = 'range'
        slider.min = '4'
        slider.max = '20'
        slider.step = '0.5'
        slider.style.cssText = ['flex:1', 'min-width:90px', 'accent-color:#5B9DFF'].join(';')

        const val = document.createElement('span')
        val.style.cssText = ['min-width:42px', 'text-align:right', 'white-space:nowrap'].join(';')

        slider.addEventListener('pointerdown', () => busySlider.add(spec.id))
        slider.addEventListener('pointerup', () => busySlider.delete(spec.id))
        slider.addEventListener('input', () => {
          val.textContent = Number(slider.value) + 'vw'
          const el = els.get(spec.id)
          if (el) el.style.width = slider.value + '%'
        })
        slider.addEventListener('change', () => {
          busySlider.delete(spec.id)
          invokeSet('setSize', spec.id, Number(slider.value))
        })

        row.appendChild(slider)
        row.appendChild(val)
        refs.slider = slider
        refs.val = val
      }

      if (spec.caps.power) {
        const b = btn('')
        b.addEventListener('click', () => invokeSet('setPower', spec.id, !specOf(spec.id).on))
        row.appendChild(b)
        refs.power = b
      }

      if (spec.caps.hide) {
        const b = btn('')
        b.addEventListener('click', () => invokeSet('setHidden', spec.id, !specOf(spec.id).hidden))
        row.appendChild(b)
        refs.hide = b
      }

      if (spec.caps.flip) {
        const b = btn('')
        b.addEventListener('click', () => invokeSet('setFlip', spec.id, !specOf(spec.id).flip))
        row.appendChild(b)
        refs.flip = b
      }

      rowRefs.set(spec.id, refs)
      return row
    }

    const syncRow = (spec) => {
      const refs = rowRefs.get(spec.id)
      if (!refs) return
      const hidden = spec.hidden ? ' · 已隐藏' : ''
      refs.name.textContent = `${spec.label} · ${stateWord(spec)} · ${Math.round(spec.x * 100)}%${hidden}`
      if (refs.slider && !busySlider.has(spec.id)) {
        refs.slider.value = String(spec.width)
        refs.val.textContent = spec.width + 'vw'
      }
      if (refs.power) {
        refs.power.textContent = spec.on ? (spec.powerLabels?.off || '关掉') : (spec.powerLabels?.on || '打开')
      }
      if (refs.hide) refs.hide.textContent = spec.hidden ? '显示' : '隐藏'
      if (refs.flip) refs.flip.textContent = spec.flip ? '取消镜像' : '镜像'
    }

    const makeEl = (spec) => {
      const img = document.createElement('img')
      img.alt = spec.label
      img.draggable = false
      img.style.cssText = [
        'position:absolute',
        'bottom:0',
        'left:50%',
        'width:9%',
        'transform:translateX(-50%)',
        'cursor:grab',
        '-webkit-user-drag:none',
        'touch-action:none',
        'z-index:10',
        'transition:opacity .2s ease',
      ].join(';')
      img.addEventListener('pointerdown', (e) => onDown(e, spec.id))
      return img
    }

    /** 把服务端返回的家具列表刷到舞台和行上。 */
    const applyList = (list) => {
      list.forEach((f, i) => {
        specs.set(f.id, f)
        let el = els.get(f.id)
        if (!el) {
          el = makeEl(f)
          els.set(f.id, el)
          wrap.appendChild(el)
        }
        place(f, 10 + i)
      })

      // 服务端已经没有的家具，从舞台上收掉
      for (const [id, el] of [...els]) {
        if (!list.some((f) => f.id === id)) {
          el.remove()
          els.delete(id)
          specs.delete(id)
          rowRefs.get(id)?.row.remove()
          rowRefs.delete(id)
        }
      }

      // 家具集合变了才重建控制行（顺序即 state.furniture 顺序：电视在上、书架在下）
      const key = list.map((f) => f.id).join(',')
      if (key !== rowKey) {
        rowKey = key
        rows.textContent = ''
        rowRefs.clear()
        for (const f of list) rows.appendChild(buildRow(f))
      }
      for (const f of list) syncRow(f)
    }

    const onDown = (e, id) => {
      if (e.button !== 0) return
      drag = { id, startX: e.clientX, moved: false }
      const el = els.get(id)
      if (el) el.style.cursor = 'grabbing'
      try { e.target.setPointerCapture?.(e.pointerId) } catch { /* 忽略 */ }
      e.preventDefault()
    }

    window.addEventListener('pointermove', (e) => {
      if (!drag) return
      if (!drag.moved && Math.abs(e.clientX - drag.startX) <= 4) return
      drag.moved = true
      const r = wrap.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)))
      const spec = specOf(drag.id)
      const el = els.get(drag.id)
      if (el) el.style.left = (x * 100).toFixed(2) + '%'
      if (spec) {
        spec.x = x
        syncRow(spec)
        hud.textContent = `${spec.label} ${Math.round(x * 100)}%`
      }
    })

    window.addEventListener('pointerup', () => {
      if (!drag) return
      const { id, moved } = drag
      drag = null
      const el = els.get(id)
      if (el) el.style.cursor = 'grab'
      if (!moved) return
      const spec = specOf(id)
      if (!spec) return
      Promise.resolve()
        .then(() => ctx.invoke('setPosition', [id, spec.x]))
        .catch(() => {})
      sync()
    })

    const sync = () => Promise.resolve()
      .then(() => ctx.invoke('state'))
      .then((s) => {
        if (!s || !Array.isArray(s.furniture)) return
        const list = s.furniture.map((f) => ({ ...f }))
        // 正在拖的那件不要被轮询拉回去
        if (drag) {
          const i = list.findIndex((f) => f.id === drag.id)
          const cur = specOf(drag.id)
          if (i >= 0 && cur) list[i].x = cur.x
        }
        applyList(list)
        if (!drag) hud.textContent = '拖动舞台上的家具调整位置，松手自动保存'
      })
      .catch(() => {})

    hud.textContent = '加载中…'
    sync()
    Promise.resolve()
      .then(() => ctx.invoke('images'))
      .then((map) => {
        if (!map || typeof map !== 'object') throw new Error('no images')
        images = map
        imagesReady = true
        for (const spec of specs.values()) paint(spec)
      })
      .catch(() => { hud.textContent = '图片加载失败' })

    if (typeof ctx.interval === 'function') ctx.interval(sync, 2000)
  },
}

export default { panels: { furniture: panel } }
