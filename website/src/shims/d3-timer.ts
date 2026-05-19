export function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

export function timer(callback: (elapsed: number) => void, delay = 0, time = now()) {
  let stopped = false
  let frame = 0
  let timeout: ReturnType<typeof setTimeout> | undefined

  const tick = () => {
    if (stopped) return
    callback(now() - time)
    frame = requestAnimationFrame(tick)
  }

  const start = (nextCallback: (elapsed: number) => void, nextDelay = 0, nextTime = now()) => {
    stop()
    callback = nextCallback
    time = nextTime
    stopped = false
    timeout = setTimeout(() => {
      frame = requestAnimationFrame(tick)
    }, Math.max(0, nextDelay))
  }

  const stop = () => {
    stopped = true
    if (timeout) clearTimeout(timeout)
    if (frame) cancelAnimationFrame(frame)
  }

  start(callback, delay, time)
  return { restart: start, stop }
}

export function timeout(callback: (elapsed: number) => void, delay = 0, time = now()) {
  const t = timer((elapsed) => {
    t.stop()
    callback(elapsed)
  }, delay, time)
  return t
}

export function interval(callback: (elapsed: number) => void, delay = 0, time = now()) {
  let stopped = false
  let intervalId: ReturnType<typeof setInterval> | undefined
  const start = (nextCallback: (elapsed: number) => void, nextDelay = delay, nextTime = now()) => {
    stop()
    callback = nextCallback
    time = nextTime
    stopped = false
    intervalId = setInterval(() => {
      if (!stopped) callback(now() - time)
    }, Math.max(1, nextDelay))
  }
  const stop = () => {
    stopped = true
    if (intervalId) clearInterval(intervalId)
  }
  start(callback, delay, time)
  return { restart: start, stop }
}

export function timerFlush() {}
