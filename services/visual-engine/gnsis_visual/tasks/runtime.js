// Evaluation-only page runtime: records task state and exposes the labelling
// oracle. The visual engine never reads any of this; only the harness does.
;(() => {
	const spec = window.__spec
	const S = { clicked: [], wrong: false, submitted: false, loading: false, overlay: !!spec.overlay }
	window.__st = S
	const el = (k) => document.querySelector(`[data-k="${k}"]`)
	const box = (k) => {
		const r = el(k).getBoundingClientRect()
		return [r.x, r.y, r.width, r.height]
	}
	const inView = (k) => {
		const r = el(k).getBoundingClientRect()
		return r.top >= 4 && r.bottom <= innerHeight - 4
	}
	const dirTo = (k) => (el(k).getBoundingClientRect().top < 0 ? 'up' : 'down')
	const busy = document.getElementById('busy')
	const setLoading = (ms, then) => {
		S.loading = true
		busy.style.display = 'flex'
		setTimeout(() => {
			S.loading = false
			busy.style.display = 'none'
			then && then()
		}, ms)
	}
	const toast = (text) => {
		const t = document.getElementById('toast')
		t.textContent = text
		t.style.display = 'block'
	}
	if (spec.loadingStart) setLoading(spec.loadingStart)
	if (spec.startAtBottom)
		window.addEventListener('load', () => scrollTo(0, document.body.scrollHeight))
	document.addEventListener(
		'click',
		(ev) => {
			const node = ev.target.closest('[data-k]')
			if (!node) return
			const k = node.dataset.k
			if (spec.overlay && k === spec.overlay.dismiss) {
				S.overlay = false
				document.getElementById('overlay').remove()
				return
			}
			if (node.tagName === 'INPUT') return
			ev.preventDefault()
			if (node.dataset.href) {
				location.href = node.dataset.href
				return
			}
			S.clicked.push(k)
			const done = () => toast(spec.confirm[k] || `Opened ${node.textContent.trim()}`)
			if (spec.family === 'type' && k === spec.submit) {
				S.submitted = true
				const fin = () => {
					document.getElementById('form').innerHTML =
						`<h2>Thanks! Your details were submitted.</h2>`
				}
				spec.loadingAfter ? setLoading(spec.loadingAfter, fin) : fin()
				return
			}
			if ((spec.family === 'click' || spec.family === 'scroll') && k === spec.target) {
				spec.loadingAfter ? setLoading(spec.loadingAfter, done) : done()
				return
			}
			S.wrong = true
			toast(`Opened ${node.textContent.trim()}`)
		},
		true
	)
	const fieldsOk = () => (spec.fields || []).every((f) => el(f.key).value === f.value)
	const decoysClean = () => (spec.decoys || []).every((k) => el(k).value === '')
	window.__oracle = () => {
		if (S.loading) return { action: 'wait' }
		if (S.overlay) return { action: 'recover', target: box(spec.overlay.dismiss) }
		switch (spec.family) {
			case 'arrive':
				return { action: 'done' }
			case 'navigate':
				return { action: 'navigate', value: spec.url }
			case 'back':
				return { action: 'back' }
			case 'click':
			case 'scroll':
				if (S.clicked.includes(spec.target)) return { action: 'done' }
				if (!inView(spec.target)) return { action: 'scroll', value: dirTo(spec.target) }
				return { action: 'click', target: box(spec.target) }
			case 'type':
				if (S.submitted) return { action: 'done' }
				for (const f of spec.fields) {
					if (el(f.key).value !== f.value) {
						if (!inView(f.key)) return { action: 'scroll', value: dirTo(f.key) }
						return { action: 'type', target: box(f.key), value: f.value }
					}
				}
				if (spec.submit && !S.submitted) {
					if (!inView(spec.submit)) return { action: 'scroll', value: dirTo(spec.submit) }
					return { action: 'click', target: box(spec.submit) }
				}
				return { action: 'done' }
		}
		return { action: 'done' }
	}
	window.__success = () => {
		if (S.wrong || S.loading) return false
		switch (spec.family) {
			case 'arrive':
				return true
			case 'click':
			case 'scroll':
				return S.clicked.includes(spec.target)
			case 'type':
				return (!spec.submit || S.submitted) && (S.submitted || (fieldsOk() && decoysClean()))
		}
		return false
	}
})()
