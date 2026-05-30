import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../../context/ThemeContext'
import { motion } from 'framer-motion'

type FeatureKind = 'mesh' | 'speed' | 'modular' | 'secure'
type ModelLogoId = 'nvidia' | 'mistral' | 'deepseek' | 'qwen' | 'llama' | 'gemini' | 'huggingface' | 'pytorch' | 'langchain'

type Point = {
  x: number
  y: number
}

type Edge = [Point, Point]

type HeroParticle = Point & {
  vx: number
  vy: number
  tx: number
  ty: number
  ox: number
  oy: number
  oz: number
  z: number
  size: number
  color: string
  phase: number
  drift: number
  group: 'core' | 'ring1' | 'ring2' | 'ring3' | 'starfield'
}

type BlasterShot = {
  from: HeroParticle
  to: HeroParticle
  progress: number // 0 to 1
  speed: number
  color: string
  state: 'charging' | 'flying' | 'exploding'
  explosionProgress: number
}

type WordParticle = Point & {
  vx: number
  vy: number
  tx: number
  ty: number
  size: number
  color: string
  phase: number
}

type ShapeParticle = Point & {
  vx: number
  vy: number
  base: Point
  phase: number
  size: number
  isChaotic?: boolean
}

const modelColors = {
  nvidia: '#76b900',
  mistral: '#ff8a1f',
  deepseek: '#4f6dff',
  qwen: '#6548f6',
  llama: '#1688e8',
  microsoft: '#00a4ef',
}





const features: { kind: FeatureKind; color: string; title: string; body: string }[] = [
  {
    kind: 'mesh',
    color: modelColors.nvidia,
    title: 'Réseau GPU mondial',
    body: 'Des machines disponibles s’agrègent en temps réel pour former une capacité distribuée.',
  },
  {
    kind: 'speed',
    color: modelColors.deepseek,
    title: 'Routage haute vitesse',
    body: 'Les calculs trouvent le meilleur chemin entre proximité, charge et capacité effective.',
  },
  {
    kind: 'modular',
    color: modelColors.qwen,
    title: 'Écosystème ouvert',
    body: 'Modèles, moteurs d’exécution et nœuds se connectent librement sur une même couche de calcul.',
  },
  {
    kind: 'secure',
    color: modelColors.mistral,
    title: 'Exécution isolée',
    body: 'Chaque calcul reste borné, éphémère et segmenté pour protéger les charges sensibles.',
  },
]

const logos = [
  { id: 'nvidia', alt: 'NVIDIA' },
  { id: 'mistral', alt: 'Mistral AI' },
  { id: 'deepseek', alt: 'DeepSeek' },
  { id: 'qwen', alt: 'Qwen' },
  { id: 'llama', alt: 'Llama' },
  { id: 'gemini', alt: 'Gemma' },
  { id: 'huggingface', alt: 'Hugging Face' },
  { id: 'pytorch', alt: 'PyTorch' },
  { id: 'langchain', alt: 'LangChain' },
] satisfies { id: ModelLogoId; alt: string }[]

const logoGlyphs: Record<ModelLogoId, ReactNode> = {
  nvidia: (
    <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" />
  ),
  mistral: (
    <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
  ),
  deepseek: (
    <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
  ),
  qwen: (
    <path d="M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" />
  ),
  llama: (
    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
  ),
  gemini: (
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  ),
  huggingface: (
    <path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624" />
  ),
  pytorch: (
    <path d="M12.005 0L4.952 7.053a9.865 9.865 0 000 14.022 9.866 9.866 0 0014.022 0c3.984-3.9 3.986-10.205.085-14.023l-1.744 1.743c2.904 2.905 2.904 7.634 0 10.538s-7.634 2.904-10.538 0-2.904-7.634 0-10.538l4.647-4.646.582-.665zm3.568 3.899a1.327 1.327 0 00-1.327 1.327 1.327 1.327 0 001.327 1.328A1.327 1.327 0 0016.9 5.226 1.327 1.327 0 0015.573 3.9z" />
  ),
  langchain: (
    <path d="M7.53 15.975a7.53 7.53 0 0 0 2.206-5.325A7.54 7.54 0 0 0 7.53 5.325L2.205 0A7.54 7.54 0 0 0 0 5.325a7.54 7.54 0 0 0 2.205 5.325zm11.144.493a7.54 7.54 0 0 0-5.325-2.206 7.54 7.54 0 0 0-5.325 2.206l5.325 5.325a7.54 7.54 0 0 0 5.325 2.205A7.54 7.54 0 0 0 24 21.793zM2.219 21.78a7.54 7.54 0 0 0 5.325 2.205v-7.53H.014a7.54 7.54 0 0 0 2.205 5.325M20.73 8.595a7.53 7.53 0 0 0-5.327-2.206 7.53 7.53 0 0 0-5.325 2.207l5.325 5.325z" />
  ),
}

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return { width, height }
}

function addLine(pts: Point[], edges: Edge[], x1: number, y1: number, x2: number, y2: number, steps = 16) {
  let previous: Point | null = null
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const point = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }
    pts.push(point)
    if (previous) edges.push([previous, point])
    previous = point
  }
}


function addRect(pts: Point[], edges: Edge[], x: number, y: number, width: number, height: number, steps = 8) {
  addLine(pts, edges, x, y, x + width, y, steps)
  addLine(pts, edges, x + width, y, x + width, y + height, steps)
  addLine(pts, edges, x + width, y + height, x, y + height, steps)
  addLine(pts, edges, x, y + height, x, y, steps)
}

function addCircle(
  pts: Point[],
  edges: Edge[],
  cx: number,
  cy: number,
  radius: number,
  steps = 42,
  start = 0,
  end = Math.PI * 2,
) {
  let previous: Point | null = null
  let first: Point | null = null
  for (let i = 0; i <= steps; i += 1) {
    const angle = start + ((end - start) * i) / steps
    const point = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
    pts.push(point)
    if (previous) {
      edges.push([previous, point])
    } else {
      first = point
    }
    previous = point
  }
  if (first && previous && end - start >= Math.PI * 2 - 0.01) edges.push([previous, first])
}

function makeFeatureTargets(kind: FeatureKind, width: number, height: number) {
  const pts: Point[] = []
  const edges: Edge[] = []
  const center = { x: width * 0.5, y: height * 0.5 }
  const unit = Math.min(width, height)

  function addPolyline(path: Point[]) {
    let previous: Point | null = null
    path.forEach((point) => {
      pts.push(point)
      if (previous) edges.push([previous, point])
      previous = point
    })
  }



  if (kind === 'mesh') {
    // Beautiful concentric mesh radar, made larger (radius 0.36)
    const r1 = unit * 0.12
    const r2 = unit * 0.24
    const r3 = unit * 0.36

    // Concentric rings
    addCircle(pts, edges, center.x, center.y, r1, 24)
    addCircle(pts, edges, center.x, center.y, r2, 38)
    addCircle(pts, edges, center.x, center.y, r3, 48)

    // Diagonal and cardinal grid lines
    const angles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]
    angles.forEach((angle) => {
      const x1 = center.x - Math.cos(angle) * r3
      const y1 = center.y - Math.sin(angle) * r3
      const x2 = center.x + Math.cos(angle) * r3
      const y2 = center.y + Math.sin(angle) * r3
      addLine(pts, edges, x1, y1, x2, y2, 16)
    })

    // Symmetrical satellite nodes
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2 + Math.PI / 4
      const cx = center.x + Math.cos(angle) * r2
      const cy = center.y + Math.sin(angle) * r2
      addCircle(pts, edges, cx, cy, unit * 0.035, 12)
    }
  }

  if (kind === 'speed') {
    // Beautiful routing highway: 3 tracks merging from left into a central processing circle,
    // then launching as a single high-speed speedway to the right with chevrons.
    const cy = center.y
    const xStart = width * 0.14
    const xEnd = width * 0.86
    
    // Central circular node (made larger)
    const rCore = unit * 0.09
    addCircle(pts, edges, center.x, cy, rCore, 24)
    addCircle(pts, edges, center.x, cy, unit * 0.04, 12)

    // Left tracks: top, middle, bottom merging into the central node
    addLine(pts, edges, xStart, cy - unit * 0.20, center.x - rCore, cy, 12)
    addLine(pts, edges, xStart, cy, center.x - rCore, cy, 12)
    addLine(pts, edges, xStart, cy + unit * 0.20, center.x - rCore, cy, 12)

    // Right track: single high-speed speedway launching to the right
    addLine(pts, edges, center.x + rCore, cy, xEnd, cy, 14)

    // Symmetrical speed chevrons along the right highway
    const rightSideW = xEnd - (center.x + rCore)
    const chevronsX = [
      center.x + rCore + rightSideW * 0.28,
      center.x + rCore + rightSideW * 0.62,
    ]
    chevronsX.forEach((cx) => {
      const arrowPts = [
        { x: cx - unit * 0.035, y: cy - unit * 0.05 },
        { x: cx, y: cy },
        { x: cx - unit * 0.035, y: cy + unit * 0.05 },
      ]
      addPolyline(arrowPts)
    })
  }

  if (kind === 'modular') {
    // Beautiful decentralized modular star ecosystem
    // Central node
    addCircle(pts, edges, center.x, center.y, unit * 0.07, 16)
    addCircle(pts, edges, center.x, center.y, unit * 0.03, 10)

    // 6 peripheral nodes arranged in a large circle (radius 0.32)
    const rOuter = unit * 0.32
    const numNodes = 6
    const nodeCoords: Point[] = []

    for (let i = 0; i < numNodes; i++) {
      const angle = (i * Math.PI * 2) / numNodes - Math.PI / 2
      const px = center.x + Math.cos(angle) * rOuter
      const py = center.y + Math.sin(angle) * rOuter
      nodeCoords.push({ x: px, y: py })

      // Small circle node at each tip
      addCircle(pts, edges, px, py, unit * 0.04, 12)

      // Radial lines connecting central node to each peripheral node
      addLine(pts, edges, center.x, center.y, px, py, 10)
    }

    // Outer polygon lines forming a gorgeous closed hexagon ring
    for (let i = 0; i < numNodes; i++) {
      const p1 = nodeCoords[i]
      const p2 = nodeCoords[(i + 1) % numNodes]
      addLine(pts, edges, p1.x, p1.y, p2.x, p2.y, 10)
    }
  }

  if (kind === 'secure') {
    // Beautiful highly detailed high-tech U-shackled Padlock (cadenas), taller and placed higher
    const bodyW = unit * 0.26
    const bodyH = unit * 0.22
    const bodyTop = center.y - unit * 0.08

    // 1. Padlock Body: Rounded rectangle at the bottom
    addRect(pts, edges, center.x - bodyW, bodyTop, bodyW * 2, bodyH, 18)

    // 2. Padlock Shackle (Anse U): An arch at the top (taller)
    const shackleR = unit * 0.16
    const shackleCenterY = bodyTop - unit * 0.08
    
    // Half circle arch
    addCircle(pts, edges, center.x, shackleCenterY, shackleR, 20, Math.PI, Math.PI * 2)

    // Vertical shackle legs connecting to padlock body (longer)
    addLine(pts, edges, center.x - shackleR, shackleCenterY, center.x - shackleR, bodyTop, 10)
    addLine(pts, edges, center.x + shackleR, shackleCenterY, center.x + shackleR, bodyTop, 10)

    // 3. High-tech keyhole inside the padlock body
    const khCY = bodyTop + bodyH * 0.45
    addCircle(pts, edges, center.x, khCY, unit * 0.035, 12)
    
    // Triangular leg of the keyhole
    const legPts = [
      { x: center.x, y: khCY },
      { x: center.x - unit * 0.016, y: khCY + unit * 0.06 },
      { x: center.x + unit * 0.016, y: khCY + unit * 0.06 },
      { x: center.x, y: khCY },
    ]
    addPolyline(legPts)
  }

  return { pts, edges }
}

function textTargets(text: string, width: number, height: number) {
  const scale = 2
  const offscreen = document.createElement('canvas')
  offscreen.width = Math.max(1, Math.round(width * scale))
  offscreen.height = Math.max(1, Math.round(height * scale))
  const ctx = offscreen.getContext('2d')
  if (!ctx) return []

  const fontSize = Math.min(132, Math.max(78, width * 0.21)) * scale
  ctx.clearRect(0, 0, offscreen.width, offscreen.height)
  ctx.font = `900 ${fontSize}px Inter, Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000'
  ctx.fillText(text, offscreen.width / 2, offscreen.height * 0.5)

  const data = ctx.getImageData(0, 0, offscreen.width, offscreen.height).data
  const points: Point[] = []
  const gap = width < 450 ? 6 : 5
  const scaledGap = gap * scale
  for (let y = 0; y < offscreen.height; y += scaledGap) {
    for (let x = 0; x < offscreen.width; x += scaledGap) {
      if (data[(y * offscreen.width + x) * 4 + 3] > 45) {
        points.push({ x: x / scale, y: y / scale })
      }
    }
  }
  return points
}

function useHeroCanvases(heroRef: RefObject<HTMLCanvasElement | null>, wordRef: RefObject<HTMLCanvasElement | null>) {
  const { resolvedTheme } = useTheme()
  const isLightMode = resolvedTheme === 'light'

  useEffect(() => {
    const hero = heroRef.current
    const word = wordRef.current
    const heroCtx = hero?.getContext('2d', { alpha: true })
    const wordCtx = word?.getContext('2d', { alpha: true })
    if (!hero || !word || !heroCtx || !wordCtx) return
    const heroCanvas: HTMLCanvasElement = hero
    const wordCanvas: HTMLCanvasElement = word
    const heroContext: CanvasRenderingContext2D = heroCtx
    const wordContext: CanvasRenderingContext2D = wordCtx

    let heroWidth = 1
    let heroHeight = 1
    let wordWidth = 1
    let wordHeight = 1
    let heroParticles: HeroParticle[] = []
    let wordParticles: WordParticle[] = []
    let blasterShots: BlasterShot[] = []
    let frame = 0
    const mouse = { x: -9999, y: -9999, wordX: -9999, wordY: -9999, wordActive: false }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function buildHero() {
      const count = heroWidth < 700 ? 820 : 1650
      heroParticles = []

      const coreCount = Math.floor(count * 0.35)
      const ring1Count = Math.floor(count * 0.20)
      const ring2Count = Math.floor(count * 0.20)
      const ring3Count = Math.floor(count * 0.20)
      const starfieldCount = count - coreCount - ring1Count - ring2Count - ring3Count

      const coreRadius = 135
      const ring1Radius = 380
      const ring2Radius = 425
      const ring3Radius = 330

      function tiltedRingPoint(theta: number, radius: number, tiltX: number, tiltY: number) {
        const rx = radius * Math.cos(theta)
        const ry = radius * Math.sin(theta)
        const rz = 0
        const cosX = Math.cos(tiltX)
        const sinX = Math.sin(tiltX)
        const y1 = ry * cosX - rz * sinX
        const z1 = ry * sinX + rz * cosX
        const cosY = Math.cos(tiltY)
        const sinY = Math.sin(tiltY)
        const x2 = rx * cosY + z1 * sinY
        const z2 = -rx * sinY + z1 * cosY
        return { x: x2, y: y1, z: z2 }
      }

      function spherePoint(index: number, total: number, radius: number) {
        const phi = Math.acos(1 - 2 * (index / (total - 1 || 1)))
        const theta = index * 2.399963229728653
        return {
          x: radius * Math.sin(phi) * Math.cos(theta),
          y: radius * Math.sin(phi) * Math.sin(theta),
          z: radius * Math.cos(phi),
        }
      }

      const pushParticle = (ox: number, oy: number, oz: number, size: number, color: string, group: 'core' | 'ring1' | 'ring2' | 'ring3' | 'starfield') => {
        const scale = 800 / (800 + oz)
        const tx = heroWidth * 0.5 + ox * scale
        const ty = heroHeight * 0.39 + oy * scale
        
        heroParticles.push({
          x: tx,
          y: ty,
          vx: 0,
          vy: 0,
          tx,
          ty,
          ox,
          oy,
          oz,
          z: oz,
          size,
          color,
          phase: Math.random() * Math.PI * 2,
          drift: 0.35 + Math.random() * 0.55,
          group,
        })
      }

      const corePrimaryColor = isLightMode ? '#4F46E5' : '#ffffff'
      for (let i = 0; i < coreCount; i++) {
        const pt = spherePoint(i, coreCount, coreRadius)
        const ox = pt.x + (Math.random() - 0.5) * 6
        const oy = pt.y + (Math.random() - 0.5) * 6
        const oz = pt.z + (Math.random() - 0.5) * 6
        const color = Math.random() > 0.45 ? corePrimaryColor : '#06B6D4'
        pushParticle(ox, oy, oz, Math.random() * 1.5 + 0.6, color, 'core')
      }

      const ring1Color = isLightMode ? '#0891B2' : '#06B6D4'
      for (let i = 0; i < ring1Count; i++) {
        const theta = (i / ring1Count) * Math.PI * 2
        const pt = tiltedRingPoint(theta, ring1Radius, 0.7, 0.5)
        pushParticle(pt.x, pt.y, pt.z, Math.random() * 1.45 + 0.5, ring1Color, 'ring1')
      }

      const ring2Color = isLightMode ? '#7C3AED' : '#8B5CF6'
      for (let i = 0; i < ring2Count; i++) {
        const theta = (i / ring2Count) * Math.PI * 2
        const pt = tiltedRingPoint(theta, ring2Radius, -0.8, -0.3)
        pushParticle(pt.x, pt.y, pt.z, Math.random() * 1.45 + 0.5, ring2Color, 'ring2')
      }

      const ring3Color = isLightMode ? '#4338CA' : '#4F46E5'
      for (let i = 0; i < ring3Count; i++) {
        const theta = (i / ring3Count) * Math.PI * 2
        const pt = tiltedRingPoint(theta, ring3Radius, 0.3, 1.1)
        pushParticle(pt.x, pt.y, pt.z, Math.random() * 1.45 + 0.5, ring3Color, 'ring3')
      }

      const activePalette = isLightMode
        ? ['#0891B2', '#7C3AED', '#4338CA', '#2563EB']
        : ['#06B6D4', '#8B5CF6', '#4F46E5', '#ffffff']
      for (let i = 0; i < starfieldCount; i++) {
        const pt = spherePoint(i, starfieldCount, coreRadius + Math.random() * 320)
        const color = activePalette[Math.floor(Math.random() * activePalette.length)]
        pushParticle(pt.x, pt.y, pt.z, Math.random() * 1.0 + 0.4, color, 'starfield')
      }
    }

    function buildWord() {
      const targets = textTargets('VRYX', wordWidth, wordHeight)
      const count = Math.min(wordWidth < 440 ? 720 : 1080, targets.length)
      wordParticles = []
      for (let i = 0; i < count; i += 1) {
        const target = targets[Math.floor((i / count) * targets.length)]
        if (!target) continue
        
        wordParticles.push({
          x: target.x,
          y: target.y,
          vx: 0,
          vy: 0,
          tx: target.x,
          ty: target.y,
          size: Math.random() * 1.18 + 0.72,
          phase: Math.random() * Math.PI * 2,
          color: Math.random() > 0.5
            ? (isLightMode ? '#0891B2' : '#06B6D4')
            : (isLightMode ? '#7C3AED' : '#8B5CF6'),
        })
      }
    }

    function resizeHero() {
      const size = fitCanvas(heroCanvas, heroContext)
      heroWidth = size.width
      heroHeight = size.height
      buildHero()
    }

    function resizeWord() {
      const size = fitCanvas(wordCanvas, wordContext)
      wordWidth = size.width
      wordHeight = size.height
      buildWord()
    }

    function drawHeroLines() {
      if (mouse.x !== -9999) {
        let linesDrawn = 0
        for (let i = 0; i < heroParticles.length; i += 2) {
          const a = heroParticles[i]
          if (a.z > 120) continue

          const dx = a.x - mouse.x
          const dy = a.y - mouse.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 135) {
            const depthFactor = Math.max(0.1, 1 - a.z / 500)
            heroContext.globalAlpha = (1 - dist / 135) * (isLightMode ? 0.42 : 0.26) * depthFactor
            heroContext.strokeStyle = a.color
            heroContext.lineWidth = 1.1
            heroContext.beginPath()
            heroContext.moveTo(mouse.x, mouse.y)
            heroContext.lineTo(a.x, a.y)
            heroContext.stroke()
            linesDrawn++
            if (linesDrawn > 24) break
          }
        }
      }
      heroContext.globalAlpha = 1
    }

    function animate(timestamp: number) {
      const D = 800
      const centerX = heroWidth * 0.5
      const centerY = heroHeight * 0.39

      if (blasterShots.length < 4 && Math.random() < 0.007 && heroParticles.length > 100) {
        const paths: [string, string][] = [
          ['ring1', 'ring2'],
          ['ring2', 'ring3'],
          ['ring3', 'core'],
          ['core', 'ring1']
        ]
        const path = paths[Math.floor(Math.random() * paths.length)]
        const fromCandidates = heroParticles.filter(p => p.group === path[0])
        const toCandidates = heroParticles.filter(p => p.group === path[1])
        
        if (fromCandidates.length > 0 && toCandidates.length > 0) {
          const fromP = fromCandidates[Math.floor(Math.random() * fromCandidates.length)]
          const toP = toCandidates[Math.floor(Math.random() * toCandidates.length)]
          
          blasterShots.push({
            from: fromP,
            to: toP,
            progress: 0,
            speed: 0.003 + Math.random() * 0.002,
            color: toP.color,
            state: 'charging',
            explosionProgress: 0
          })
        }
      }

      const alpha = timestamp * 0.00014
      const beta = timestamp * 0.00007
      const gamma = timestamp * 0.00003

      const cosA = Math.cos(alpha)
      const sinA = Math.sin(alpha)
      const cosB = Math.cos(beta)
      const sinB = Math.sin(beta)
      const cosG = Math.cos(gamma)
      const sinG = Math.sin(gamma)

      for (const particle of heroParticles) {
        const wave = Math.sin(timestamp * 0.001 * particle.drift + particle.phase) * 8.5
        const distCenter = Math.sqrt(particle.ox * particle.ox + particle.oy * particle.oy + particle.oz * particle.oz) || 1
        const ox = particle.ox + (particle.ox / distCenter) * wave
        const oy = particle.oy + (particle.oy / distCenter) * wave
        const oz = particle.oz + (particle.oz / distCenter) * wave

        const x1 = ox * cosA - oz * sinA
        const z1 = ox * sinA + oz * cosA

        const y2 = oy * cosB - z1 * sinB
        let z2 = oy * sinB + z1 * cosB

        let x3 = x1 * cosG - y2 * sinG
        let y3 = x1 * sinG + y2 * cosG

        if (mouse.x !== -9999) {
          const dx = x3 - (mouse.x - centerX)
          const dy = y3 - (mouse.y - centerY)
          const d2 = dx * dx + dy * dy
          if (d2 < 24000) {
            const pull = (1 - d2 / 24000) * 12 * particle.drift
            x3 -= (dx / (Math.sqrt(d2) || 1)) * pull
            y3 -= (dy / (Math.sqrt(d2) || 1)) * pull
            z2 -= pull * 3
          }
        }

        particle.z = z2

        const scale = D / (D + z2)
        particle.tx = centerX + x3 * scale
        particle.ty = centerY + y3 * scale
      }

      heroParticles.sort((a, b) => b.z - a.z)

      heroContext.clearRect(0, 0, heroWidth, heroHeight)
      drawHeroLines()

      for (const blaster of blasterShots) {
        if (blaster.state === 'charging') {
          blaster.progress += blaster.speed * 1.6
          if (blaster.progress >= 0.15) {
            blaster.state = 'flying'
          }

          const f = Math.max(0, (0.15 - blaster.progress) / 0.15)
          for (let j = 0; j < 4; j++) {
            const theta = f * 6.5 + j * (Math.PI / 2)
            const R = 35 * f
            const dx = R * Math.cos(theta)
            const dy = R * Math.sin(theta) * 0.5
            const dz = R * Math.sin(theta) * 0.8

            const ox = blaster.from.ox + dx
            const oy = blaster.from.oy + dy
            const oz = blaster.from.oz + dz

            const x1 = ox * cosA - oz * sinA
            const z1 = ox * sinA + oz * cosA
            const y2 = oy * cosB - z1 * sinB
            const z2 = oy * sinB + z1 * cosB
            const rx = x1 * cosG - y2 * sinG
            const ry = x1 * sinG + y2 * cosG

            const scale = D / (D + z2)
            const px = centerX + rx * scale
            const py = centerY + ry * scale

            heroContext.save()
            heroContext.fillStyle = isLightMode ? '#4F46E5' : '#ffffff'
            heroContext.shadowColor = blaster.from.color
            heroContext.shadowBlur = 7 * scale
            heroContext.beginPath()
            heroContext.arc(px, py, 2.2 * scale * f, 0, Math.PI * 2)
            heroContext.fill()
            heroContext.restore()
          }
        } 
        else if (blaster.state === 'flying') {
          blaster.progress += blaster.speed
          if (blaster.progress >= 1.0) {
            blaster.state = 'exploding'
            blaster.explosionProgress = 0
            continue
          }

          const progress = blaster.progress
          const backProgress = Math.max(0.15, progress - 0.08)

          const ox_f = blaster.from.ox + (blaster.to.ox - blaster.from.ox) * progress
          const oy_f = blaster.from.oy + (blaster.to.oy - blaster.from.oy) * progress
          const oz_f = blaster.from.oz + (blaster.to.oz - blaster.from.oz) * progress

          const ox_b = blaster.from.ox + (blaster.to.ox - blaster.from.ox) * backProgress
          const oy_b = blaster.from.oy + (blaster.to.oy - blaster.from.oy) * backProgress
          const oz_b = blaster.from.oz + (blaster.to.oz - blaster.from.oz) * backProgress

          const x1_f = ox_f * cosA - oz_f * sinA
          const z1_f = ox_f * sinA + oz_f * cosA
          const y2_f = oy_f * cosB - z1_f * sinB
          const z2_f = oy_f * sinB + z1_f * cosB
          const rx_f = x1_f * cosG - y2_f * sinG
          const ry_f = x1_f * sinG + y2_f * cosG

          const x1_b = ox_b * cosA - oz_b * sinA
          const z1_b = ox_b * sinA + oz_b * cosA
          const y2_b = oy_b * cosB - z1_b * sinB
          const z2_b = oy_b * sinB + z1_b * cosB
          const rx_b = x1_b * cosG - y2_b * sinG
          const ry_b = x1_b * sinG + y2_b * cosG

          const scale_f = D / (D + z2_f)
          const px_f = centerX + rx_f * scale_f
          const py_f = centerY + ry_f * scale_f

          const scale_b = D / (D + z2_b)
          const px_b = centerX + rx_b * scale_b
          const py_b = centerY + ry_b * scale_b

          const avgZ = (z2_f + z2_b) / 2
          const depthFactor = Math.max(0.15, Math.min(1.0, 1 - avgZ / 500))

          const segmentFade = progress < 0.25 ? (progress - 0.15) / 0.10 : 1.0

          heroContext.save()
          heroContext.lineCap = 'round'
          heroContext.lineWidth = 3.6 * scale_f * depthFactor
          heroContext.strokeStyle = isLightMode 
            ? `rgba(79, 70, 229, ${segmentFade})` 
            : `rgba(255, 255, 255, ${segmentFade})`
          heroContext.shadowColor = blaster.color
          heroContext.shadowBlur = 12 * scale_f * depthFactor

          heroContext.beginPath()
          heroContext.moveTo(px_b, py_b)
          heroContext.lineTo(px_f, py_f)
          heroContext.stroke()
          heroContext.restore()
        } 
        else if (blaster.state === 'exploding') {
          blaster.explosionProgress += 0.04
          const t_exp = blaster.explosionProgress
          if (t_exp >= 1.0) continue

          const R = 36 * Math.sin(t_exp * Math.PI) * (1 - t_exp)

          for (let j = 0; j < 4; j++) {
            const theta = t_exp * 8.5 + j * (Math.PI / 2)
            const lx = R * Math.cos(theta)
            const ly = R * Math.sin(theta) * Math.cos(j * (Math.PI / 2))
            const lz = R * Math.sin(theta) * Math.sin(j * (Math.PI / 2))

            const ox = blaster.to.ox + lx
            const oy = blaster.to.oy + ly
            const oz = blaster.to.oz + lz

            const x1 = ox * cosA - oz * sinA
            const z1 = ox * sinA + oz * cosA
            const y2 = oy * cosB - z1 * sinB
            const z2 = oy * sinB + z1 * cosB
            const rx = x1 * cosG - y2 * sinG
            const ry = x1 * sinG + y2 * cosG

            const scale = D / (D + z2)
            const px = centerX + rx * scale
            const py = centerY + ry * scale

            heroContext.save()
            heroContext.fillStyle = blaster.color
            heroContext.globalAlpha = 1 - t_exp
            heroContext.beginPath()
            heroContext.arc(px, py, 2.5 * scale * (1 - t_exp), 0, Math.PI * 2)
            heroContext.fill()
            heroContext.restore()
          }
        }
      }

      blasterShots = blasterShots.filter(b => b.state !== 'exploding' || b.explosionProgress < 1.0)

      for (const particle of heroParticles) {
        const targetX = particle.tx
        const targetY = particle.ty
        
        let ax = (targetX - particle.x) * 0.007
        let ay = (targetY - particle.y) * 0.007

        const dx = particle.x - mouse.x
        const dy = particle.y - mouse.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 145) {
          const force = (1 - dist / 145) * 0.18
          ax += (dx / (dist || 1)) * force
          ay += (dy / (dist || 1)) * force
        }

        particle.vx = (particle.vx + ax) * 0.93
        particle.vy = (particle.vy + ay) * 0.93
        particle.x += particle.vx
        particle.y += particle.vy

        const scale = D / (D + particle.z)
        const size = particle.size * scale
        const alpha = Math.max(0.08, Math.min(1.0, (1 - particle.z / 600) * 0.82))

        heroContext.globalAlpha = alpha
        heroContext.fillStyle = particle.color
        heroContext.beginPath()
        heroContext.arc(particle.x, particle.y, size, 0, Math.PI * 2)
        heroContext.fill()
      }
      heroContext.globalAlpha = 1

      wordContext.clearRect(0, 0, wordWidth, wordHeight)
      const localX = mouse.wordX
      const localY = mouse.wordY
      const magnetX = mouse.wordActive ? ((localX - wordWidth / 2) / Math.max(wordWidth / 2, 1)) * 8 : 0
      const magnetY = mouse.wordActive ? ((localY - wordHeight / 2) / Math.max(wordHeight / 2, 1)) * 6 : 0

      const wavePos = (timestamp * 0.14) % (wordWidth + 400) - 200

      for (let i = 0; i < wordParticles.length; i += 1) {
        const particle = wordParticles[i]
        
        const dx = Math.abs(particle.tx - wavePos)
        const sweepPulse = dx < 110 ? (1 - dx / 110) : 0
        const pulse = Math.sin(timestamp * 0.0022 + particle.phase) * 0.5 + 0.5

        let targetX = particle.tx + magnetX
        let targetY = particle.ty + magnetY - sweepPulse * 10

        let ax = 0
        let ay = 0
        let targetWeight = 1.0

        if (mouse.wordActive) {
          const mdx = particle.x - localX
          const mdy = particle.y - localY
          const dist = Math.sqrt(mdx * mdx + mdy * mdy)
          
          if (dist < 130) {
            const force = 1 - dist / 130
            const tX = -mdy / (dist || 1)
            const tY = mdx / (dist || 1)
            
            ax += tX * force * 1.6 - (mdx / (dist || 1)) * force * 0.5
            ay += tY * force * 1.6 - (mdy / (dist || 1)) * force * 0.5
            
            targetWeight = 1 - force * 0.82
          }
        }

        ax += (targetX - particle.x) * 0.014 * targetWeight
        ay += (targetY - particle.y) * 0.014 * targetWeight

        particle.vx = (particle.vx + ax) * 0.85
        particle.vy = (particle.vy + ay) * 0.85
        particle.x += particle.vx
        particle.y += particle.vy

        const extraSize = sweepPulse * 0.95 + pulse * 0.22
        const alpha = Math.max(0.68, Math.min(1.0, 0.76 + sweepPulse * 0.24))

        wordContext.globalAlpha = alpha
        wordContext.fillStyle = sweepPulse > 0.45 ? (isLightMode ? '#4338CA' : '#ffffff') : particle.color
        wordContext.beginPath()
        wordContext.arc(particle.x, particle.y, particle.size + extraSize, 0, Math.PI * 2)
        wordContext.fill()

        if (mouse.wordActive && i % 9 === 0) {
          const mdx = particle.x - localX
          const mdy = particle.y - localY
          const dist = Math.sqrt(mdx * mdx + mdy * mdy)
          if (dist < 110) {
            wordContext.globalAlpha = (1 - dist / 110) * 0.28
            wordContext.strokeStyle = particle.color
            wordContext.lineWidth = 0.85
            wordContext.beginPath()
            wordContext.moveTo(localX, localY)
            wordContext.lineTo(particle.x, particle.y)
            wordContext.stroke()
          }
        }
      }
      wordContext.globalAlpha = 1

      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    function onPointerMove(event: PointerEvent) {
      const heroRect = heroCanvas.getBoundingClientRect()
      const wordRect = wordCanvas.getBoundingClientRect()
      mouse.x = event.clientX - heroRect.left
      mouse.y = event.clientY - heroRect.top
      mouse.wordX = event.clientX - wordRect.left
      mouse.wordY = event.clientY - wordRect.top
      mouse.wordActive =
        mouse.wordX >= 0 && mouse.wordX <= wordRect.width && mouse.wordY >= 0 && mouse.wordY <= wordRect.height
    }

    function onPointerLeave() {
      mouse.x = -9999
      mouse.y = -9999
      mouse.wordX = -9999
      mouse.wordY = -9999
      mouse.wordActive = false
    }

    const heroObserver = new ResizeObserver(resizeHero)
    const wordObserver = new ResizeObserver(resizeWord)
    heroObserver.observe(heroCanvas)
    wordObserver.observe(wordCanvas)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave)
    resizeHero()
    resizeWord()
    frame = window.requestAnimationFrame(animate)

    return () => {
      heroObserver.disconnect()
      wordObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [heroRef, wordRef, resolvedTheme])
}

function useParticleIcon(canvasRef: RefObject<HTMLCanvasElement | null>, kind: FeatureKind, color: string) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !ctx) return
    const canvasEl: HTMLCanvasElement = canvas
    const context: CanvasRenderingContext2D = ctx

    let width = 1
    let height = 1
    let points: Point[] = []
    let edges: Edge[] = []
    let particles: ShapeParticle[] = []
    let hovering = false
    let frame = 0
    const pointer = { x: -9999, y: -9999, active: false }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function buildParticles() {
      // Increased particle count and high-density distribution
      const count = Math.min(kind === 'mesh' ? 680 : 580, Math.max(420, Math.round((width * height) / 450)))
      particles = []
      for (let i = 0; i < count; i += 1) {
        const target = points[i % Math.max(points.length, 1)] || { x: width / 2, y: height / 2 }
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 0,
          vy: 0,
          base: target,
          phase: Math.random() * Math.PI * 2,
          size: Math.random() * 1.8 + 0.8, // More varied size for organic tech look
          isChaotic: Math.random() > 0.95, // 5% of particles remain chaotic on hover
        })
      }
    }

    function resize() {
      const size = fitCanvas(canvasEl, context)
      width = size.width
      height = size.height
      const shape = makeFeatureTargets(kind, width, height)
      points = shape.pts
      edges = shape.edges
      buildParticles()
    }

    function animate(timestamp: number) {
      context.clearRect(0, 0, width, height)
      const active = hovering || pointer.active

      // Only draw the structural wireframe lines and flowing signals when hovered (active)
      if (active && edges.length) {
        context.save()
        context.strokeStyle = color
        context.lineCap = 'round'

        // 1. Draw smooth underlying neon glow line
        context.globalAlpha = 0.12
        context.lineWidth = 4.0
        context.beginPath()
        edges.forEach(([a, b]) => {
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
        })
        context.stroke()

        // 2. Draw sharp, crisp core line
        context.globalAlpha = 0.42
        context.lineWidth = 1.5
        context.beginPath()
        edges.forEach(([a, b]) => {
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
        })
        context.stroke()
        context.restore()

        // Draw running signals as shooting stars with glow
        const signalEvery = Math.max(2, Math.floor(edges.length / 32))
        for (let i = 0; i < edges.length; i += signalEvery) {
          const [a, b] = edges[i]
          const t = (timestamp * 0.00024 + i * 0.013) % 1
          const x = a.x + (b.x - a.x) * t
          const y = a.y + (b.y - a.y) * t
          
          // Signal outer glow
          context.globalAlpha = 0.35
          context.fillStyle = color
          context.beginPath()
          context.arc(x, y, 5.5, 0, Math.PI * 2)
          context.fill()
          
          // Signal core
          context.globalAlpha = 0.95
          context.fillStyle = '#ffffff'
          context.beginPath()
          context.arc(x, y, 2.5, 0, Math.PI * 2)
          context.fill()
        }
      }

      // Update and draw particles
      for (const particle of particles) {
        let ax = 0
        let ay = 0

        if (active) {
          if (particle.isChaotic) {
            // 5% of particles drift randomly even when hovered, with movements reduced by 4x
            ax = ((Math.random() - 0.5) * 0.15) / 4
            ay = ((Math.random() - 0.5) * 0.15) / 4
            particle.vx = (particle.vx + ax) * 0.98
            particle.vy = (particle.vy + ay) * 0.98
          } else {
            // Assembling shape state: pull extremely slowly to the shape base coordinates
            const targetX = particle.base.x + Math.cos(timestamp * 0.0018 + particle.phase) * 1.5
            const targetY = particle.base.y + Math.sin(timestamp * 0.0018 + particle.phase) * 1.5
            const stiffness = 0.0055 // Extremely slow cosmic glide
            ax = (targetX - particle.x) * stiffness
            ay = (targetY - particle.y) * stiffness

            // Mouse pointer force when hovering
            if (pointer.active) {
              const dx = particle.x - pointer.x
              const dy = particle.y - pointer.y
              const dist = Math.sqrt(dx * dx + dy * dy)
              if (dist < 120) {
                const force = (1 - dist / 120) * 0.92
                ax += (dx / (dist || 1)) * force * 1.8
                ay += (dy / (dist || 1)) * force * 1.8
              }
            }
            particle.vx = (particle.vx + ax) * 0.82
            particle.vy = (particle.vy + ay) * 0.82
          }
        } else {
          // Chaotic drift state: particles wander around randomly
          ax = (Math.random() - 0.5) * 0.15
          ay = (Math.random() - 0.5) * 0.15
          particle.vx = (particle.vx + ax) * 0.98
          particle.vy = (particle.vy + ay) * 0.98
        }

        // Soft boundary wrap-around
        if (particle.x < 0) particle.x = width
        if (particle.x > width) particle.x = 0
        if (particle.y < 0) particle.y = height
        if (particle.y > height) particle.y = 0

        particle.x += particle.vx
        particle.y += particle.vy

        const sizeMultiplier = active ? 1.35 : 0.92

        // Particle crisp core (clean dot, no glow blur ring)
        context.globalAlpha = active ? 0.95 : 0.45
        context.fillStyle = color
        context.beginPath()
        context.arc(particle.x, particle.y, particle.size * sizeMultiplier, 0, Math.PI * 2)
        context.fill()
      }

      context.globalAlpha = 1

      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    const card = canvasEl.closest('.vryx-feature-card')
    const onEnter = () => {
      hovering = true
    }
    const onMove = (event: Event) => {
      const pointerEvent = event as PointerEvent
      const rect = canvasEl.getBoundingClientRect()
      pointer.x = pointerEvent.clientX - rect.left
      pointer.y = pointerEvent.clientY - rect.top
      pointer.active = pointer.x >= 0 && pointer.x <= rect.width && pointer.y >= 0 && pointer.y <= rect.height
    }
    const onLeave = () => {
      hovering = false
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvasEl)
    card?.addEventListener('pointerenter', onEnter)
    card?.addEventListener('pointermove', onMove, { passive: true })
    card?.addEventListener('pointerleave', onLeave)
    resize()
    frame = window.requestAnimationFrame(animate)

    return () => {
      observer.disconnect()
      card?.removeEventListener('pointerenter', onEnter)
      card?.removeEventListener('pointermove', onMove)
      card?.removeEventListener('pointerleave', onLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [canvasRef, color, kind])
}

function IconCanvas({ kind, color }: { kind: FeatureKind; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useParticleIcon(canvasRef, kind, color)
  return <canvas ref={canvasRef} className="vryx-feature-canvas" aria-hidden />
}

function useMapCanvas(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const { resolvedTheme } = useTheme()
  const isLight = resolvedTheme === 'light'

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !ctx) return
    const canvasEl: HTMLCanvasElement = canvas
    const context: CanvasRenderingContext2D = ctx

    let width = 1
    let height = 1
    let frame = 0
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // 3D rotation state
    let rx = -0.28 // Slightly tilted up (POV above equator, exposing the Northern hemisphere)
    let ry = 0.0
    let isDragging = false
    let previousMousePosition = { x: 0, y: 0 }

    type Point3D = {
      x: number
      y: number
      z: number
      isLand: boolean
    }

    type WorkerNode = {
      name: string
      lat: number // radians
      lon: number // radians
      color: string
      pulse: number
    }

    const globeParticles: Point3D[] = []
    let R_GLOBE = 255 // Double radius (enlarged Earth)

    // Simplified continent boundaries to map dotted continents on the 3D globe
    function checkIsLand(lat: number, lon: number): boolean {
      const latDeg = lat * (180 / Math.PI)
      const lonDeg = lon * (180 / Math.PI)

      // North America
      if (latDeg > 15 && latDeg < 75 && lonDeg > -168 && lonDeg < -52) return true
      // South America
      if (latDeg > -55 && latDeg < 12 && lonDeg > -82 && lonDeg < -34) return true
      // Europe & Asia (Eurasia)
      if (latDeg > 5 && latDeg < 78 && lonDeg > -10 && lonDeg < 148) return true
      // Africa
      if (latDeg > -35 && latDeg < 36 && lonDeg > -18 && lonDeg < 51) return true
      // Australia / Oceania
      if (latDeg > -44 && latDeg < -10 && lonDeg > 112 && lonDeg < 154) return true
      // Greenland
      if (latDeg > 60 && latDeg < 83 && lonDeg > -73 && lonDeg < -10) return true
      
      return false
    }

    // Generate Fibonacci sphere particles representing the Earth's surface
    const particleCount = 1600
    for (let i = 0; i < particleCount; i++) {
      const y = 1 - (i / (particleCount - 1)) * 2 // y goes from 1 to -1
      const radius = Math.sqrt(1 - y * y) // radius at y
      const goldenRatio = (1 + Math.sqrt(5)) / 2
      const theta = (2 * Math.PI * i) / (goldenRatio * goldenRatio) // Golden angle increment

      const x = Math.cos(theta) * radius
      const z = Math.sin(theta) * radius

      // Compute lat and lon in radians
      const lat = Math.asin(y)
      const lon = Math.atan2(x, -z)

      const isLand = checkIsLand(lat, lon)

      globeParticles.push({
        x: x * R_GLOBE,
        y: y * R_GLOBE,
        z: z * R_GLOBE,
        isLand,
      })
    }

    // Dynamic high-fidelity continent sampler from real SVG
    const img = new Image()
    img.src = '/world-map.svg'
    img.onload = () => {
      const offscreen = document.createElement('canvas')
      offscreen.width = 360
      offscreen.height = 180
      const oCtx = offscreen.getContext('2d')
      if (!oCtx) return
      oCtx.clearRect(0, 0, 360, 180)
      oCtx.drawImage(img, 0, 0, 360, 180)
      try {
        const imgData = oCtx.getImageData(0, 0, 360, 180).data
        globeParticles.length = 0
        for (let i = 0; i < particleCount; i++) {
          const y = 1 - (i / (particleCount - 1)) * 2
          const radius = Math.sqrt(1 - y * y)
          const goldenRatio = (1 + Math.sqrt(5)) / 2
          const theta = (2 * Math.PI * i) / (goldenRatio * goldenRatio)

          const x = Math.cos(theta) * radius
          const z = Math.sin(theta) * radius

          const lat = Math.asin(y)
          const lon = Math.atan2(x, -z)

          // Map lat/lon to equirectangular offscreen canvas coordinates
          // lon: -PI to PI -> x: 0 to 360
          const mapX = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * 360) % 360
          // lat: PI/2 to -PI/2 -> y: 0 to 180
          const mapY = Math.floor(((Math.PI / 2 - lat) / Math.PI) * 180) % 180

          const idx = (mapY * 360 + mapX) * 4
          // Check for opacity (alpha) or any color channel density
          const isLand = imgData[idx + 3] > 15 || (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) > 15

          globeParticles.push({
            x: x * R_GLOBE,
            y: y * R_GLOBE,
            z: z * R_GLOBE,
            isLand,
          })
        }
      } catch (e) {
        console.warn("Failed to sample high-fidelity world-map.svg for 3D Globe, using mathematical fallback:", e)
      }
    }

    // 12 Real Global Workers
    const workers: WorkerNode[] = [
      { name: 'San Francisco', lat: 37.77 * (Math.PI / 180), lon: -122.42 * (Math.PI / 180), color: '#06b6d4', pulse: Math.random() * Math.PI },
      { name: 'New York', lat: 40.71 * (Math.PI / 180), lon: -74.00 * (Math.PI / 180), color: '#8b5cf6', pulse: Math.random() * Math.PI },
      { name: 'Sao Paulo', lat: -23.55 * (Math.PI / 180), lon: -46.63 * (Math.PI / 180), color: '#4f46e5', pulse: Math.random() * Math.PI },
      { name: 'London', lat: 51.50 * (Math.PI / 180), lon: -0.12 * (Math.PI / 180), color: '#06b6d4', pulse: Math.random() * Math.PI },
      { name: 'Paris', lat: 48.85 * (Math.PI / 180), lon: 2.35 * (Math.PI / 180), color: '#8b5cf6', pulse: Math.random() * Math.PI },
      { name: 'Frankfurt', lat: 50.11 * (Math.PI / 180), lon: 8.68 * (Math.PI / 180), color: '#4f46e5', pulse: Math.random() * Math.PI },
      { name: 'Cape Town', lat: -33.92 * (Math.PI / 180), lon: 18.42 * (Math.PI / 180), color: '#06b6d4', pulse: Math.random() * Math.PI },
      { name: 'Dubai', lat: 25.20 * (Math.PI / 180), lon: 55.27 * (Math.PI / 180), color: '#8b5cf6', pulse: Math.random() * Math.PI },
      { name: 'Bangalore', lat: 12.97 * (Math.PI / 180), lon: 77.59 * (Math.PI / 180), color: '#4f46e5', pulse: Math.random() * Math.PI },
      { name: 'Singapore', lat: 1.35 * (Math.PI / 180), lon: 103.82 * (Math.PI / 180), color: '#06b6d4', pulse: Math.random() * Math.PI },
      { name: 'Tokyo', lat: 35.68 * (Math.PI / 180), lon: 139.69 * (Math.PI / 180), color: '#8b5cf6', pulse: Math.random() * Math.PI },
      { name: 'Sydney', lat: -33.87 * (Math.PI / 180), lon: 151.21 * (Math.PI / 180), color: '#4f46e5', pulse: Math.random() * Math.PI },
    ]

    // Set of P2P links between specific cities
    const links: [number, number][] = [
      [0, 1], // SF - NY
      [1, 4], // NY - Paris
      [3, 4], // London - Paris
      [4, 5], // Paris - Frankfurt
      [5, 7], // Frankfurt - Dubai
      [7, 8], // Dubai - Bangalore
      [8, 9], // Bangalore - Singapore
      [9, 10], // Singapore - Tokyo
      [10, 11], // Tokyo - Sydney
      [0, 10], // SF - Tokyo
      [2, 1], // Sao Paulo - NY
      [2, 6], // Sao Paulo - Cape Town
      [6, 7], // Cape Town - Dubai
      [9, 11], // Singapore - Sydney
    ]

    function resize() {
      const size = fitCanvas(canvasEl, context)
      width = size.width
      height = size.height
      // Scale radius dynamically to be double size on desktop, fitting viewport nicely without clipping
      R_GLOBE = Math.min(270, Math.max(140, Math.round(Math.min(width, height) * 0.44)))
    }

    // 3D rotation and projection formula
    function project3D(x: number, y: number, z: number) {
      // Rotate Y (ry)
      const x1 = x * Math.cos(ry) - z * Math.sin(ry)
      const z1 = x * Math.sin(ry) + z * Math.cos(ry)

      // Rotate X (rx)
      const y2 = y * Math.cos(rx) - z1 * Math.sin(rx)
      const z2 = y * Math.sin(rx) + z1 * Math.cos(rx)

      // 2D projection centered on canvas
      const scale = 360 / (360 + z2 * 0.15) // Slight perspective
      return {
        x: width * 0.5 + x1 * scale,
        y: height * 0.5 - y2 * scale,
        z: z2, // keep depth for back-to-front sorting
      }
    }

    function animate(timestamp: number) {
      context.clearRect(0, 0, width, height)

      // Slow auto rotation if not dragging
      if (!isDragging) {
        ry += 0.0018
      }

      const centerX = width * 0.5
      const centerY = height * 0.5

      // 1. Draw elegant background glow representing the atmosphere
      const atmosphereGlow = context.createRadialGradient(centerX, centerY, R_GLOBE * 0.8, centerX, centerY, R_GLOBE * 1.35)
      atmosphereGlow.addColorStop(0, 'transparent')
      atmosphereGlow.addColorStop(0.65, isLight ? 'rgba(99, 102, 241, 0.025)' : 'rgba(6, 182, 212, 0.025)')
      atmosphereGlow.addColorStop(1, 'transparent')
      context.fillStyle = atmosphereGlow
      context.beginPath()
      context.arc(centerX, centerY, R_GLOBE * 1.4, 0, Math.PI * 2)
      context.fill()

      type Renderable = {
        type: 'particle' | 'node' | 'link'
        depth: number
        draw: () => void
      }

      const renderList: Renderable[] = []

      // Project Earth Dotted Particles
      globeParticles.forEach((p) => {
        const proj = project3D(p.x, p.y, p.z)
        const isBack = proj.z > 0 // depth check (z positive is background)

        renderList.push({
          type: 'particle',
          depth: proj.z,
          draw: () => {
            const opacity = isBack ? 0.075 : (p.isLand ? 0.58 : 0.14)
            context.fillStyle = p.isLand
              ? (isLight ? '#4f46e5' : '#06b6d4')
              : (isLight ? '#94a3b8' : '#334155')

            context.globalAlpha = opacity
            context.beginPath()
            context.arc(proj.x, proj.y, p.isLand ? 1.35 : 0.85, 0, Math.PI * 2)
            context.fill()
          },
        })
      })

      // Project Worker Nodes
      const projectedNodes: (Point & { depth: number; color: string; pulse: number; name: string })[] = []
      workers.forEach((w) => {
        // Convert spherical coords to 3D Cartesian coords
        const x = R_GLOBE * Math.cos(w.lat) * Math.sin(w.lon)
        const y = R_GLOBE * Math.sin(w.lat)
        const z = -R_GLOBE * Math.cos(w.lat) * Math.cos(w.lon)

        const proj = project3D(x, y, z)
        projectedNodes.push({
          x: proj.x,
          y: proj.y,
          depth: proj.z,
          color: w.color,
          pulse: Math.sin(timestamp * 0.0035 + w.pulse) * 0.5 + 0.5,
          name: w.name,
        })
      })

      projectedNodes.forEach((node) => {
        const isBack = node.depth > 0

        renderList.push({
          type: 'node',
          depth: node.depth,
          draw: () => {
            context.globalAlpha = isBack ? 0.15 : 1.0

            // Pulsing ring
            context.strokeStyle = node.color
            context.lineWidth = 1.0
            context.beginPath()
            context.arc(node.x, node.y, 3 + node.pulse * 12, 0, Math.PI * 2)
            context.stroke()

            // Outer halo
            context.fillStyle = node.color
            context.globalAlpha = isBack ? 0.08 : 0.28
            context.beginPath()
            context.arc(node.x, node.y, 6, 0, Math.PI * 2)
            context.fill()

            // Core dot
            context.globalAlpha = isBack ? 0.22 : 1.0
            context.fillStyle = '#ffffff'
            context.beginPath()
            context.arc(node.x, node.y, 2.2, 0, Math.PI * 2)
            context.fill()

            // Label (Only front nodes)
            if (!isBack) {
              context.fillStyle = isLight ? '#4a5568' : '#a4b1c6'
              context.font = '600 8.5px Inter, monospace'
              context.textAlign = 'center'
              context.globalAlpha = 0.88
              context.fillText(node.name, node.x, node.y - 9)
            }
          },
        })
      })

      // Project Curved 3D Arcs (P2P Links)
      links.forEach(([idxA, idxB]) => {
        const nodeA = workers[idxA]
        const nodeB = workers[idxB]

        // Spherical interpolation to draw 3D arcs lofted slightly into space
        const steps = 18
        const arcPoints: { x: number; y: number; z: number }[] = []

        for (let i = 0; i <= steps; i++) {
          const t = i / steps
          // Intermediate lat/lon
          const lat = nodeA.lat + (nodeB.lat - nodeA.lat) * t
          const lon = nodeA.lon + (nodeB.lon - nodeA.lon) * t

          // Loft factor (highest in the middle)
          const loft = Math.sin(t * Math.PI) * 22

          const x = (R_GLOBE + loft) * Math.cos(lat) * Math.sin(lon)
          const y = (R_GLOBE + loft) * Math.sin(lat)
          const z = -(R_GLOBE + loft) * Math.cos(lat) * Math.cos(lon)

          arcPoints.push({ x, y, z })
        }

        // Project the arc points
        const projArc = arcPoints.map((pt) => project3D(pt.x, pt.y, pt.z))

        // Average depth of the arc
        const avgDepth = projArc.reduce((acc, p) => acc + p.z, 0) / projArc.length
        const isBack = avgDepth > 0

        renderList.push({
          type: 'link',
          depth: avgDepth,
          draw: () => {
            // Draw connection line
            context.save()
            context.strokeStyle = nodeA.color
            context.globalAlpha = isBack ? 0.05 : 0.28
            context.lineWidth = 1.0
            context.beginPath()
            context.moveTo(projArc[0].x, projArc[0].y)
            for (let i = 1; i < projArc.length; i++) {
              context.lineTo(projArc[i].x, projArc[i].y)
            }
            context.stroke()
            context.restore()

            // Draw flying signal packet along the arc
            const packetT = (timestamp * 0.00012 + idxA * 0.22) % 1
            const ptIdx = Math.floor(packetT * steps)
            const nextPtIdx = Math.min(steps, ptIdx + 1)
            const remainder = (packetT * steps) % 1

            if (ptIdx < projArc.length) {
              const pA = projArc[ptIdx]
              const pB = projArc[nextPtIdx] || pA
              const x = pA.x + (pB.x - pA.x) * remainder
              const y = pA.y + (pB.y - pA.y) * remainder

              context.globalAlpha = isBack ? 0.12 : 0.95
              context.fillStyle = '#ffffff'
              context.beginPath()
              context.arc(x, y, 1.8, 0, Math.PI * 2)
              context.fill()

              // Glow ring
              context.strokeStyle = nodeA.color
              context.globalAlpha = isBack ? 0.06 : 0.45
              context.beginPath()
              context.arc(x, y, 4, 0, Math.PI * 2)
              context.stroke()
            }
          },
        })
      })

      // Sort by depth (render back-to-front, higher depth value is further back)
      renderList.sort((a, b) => b.depth - a.depth)

      // Execute drawing in depth order
      renderList.forEach((item) => item.draw())

      context.globalAlpha = 1
      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    // Drag-to-spin interaction logic
    function onPointerDown(event: PointerEvent) {
      isDragging = true
      previousMousePosition = {
        x: event.clientX,
        y: event.clientY,
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (!isDragging) return
      const deltaMove = {
        x: event.clientX - previousMousePosition.x,
        y: event.clientY - previousMousePosition.y,
      }

      ry += deltaMove.x * 0.006 // Rotate Y based on horizontal drag
      rx -= deltaMove.y * 0.006 // Rotate X based on vertical drag (corrected direction)

      // Limit vertical tilt to avoid flipping completely upside down
      rx = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, rx))

      previousMousePosition = {
        x: event.clientX,
        y: event.clientY,
      }
    }

    function onPointerUp() {
      isDragging = false
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvasEl)

    canvasEl.style.cursor = 'grab'
    canvasEl.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    resize()
    frame = window.requestAnimationFrame(animate)

    return () => {
      observer.disconnect()
      canvasEl.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.cancelAnimationFrame(frame)
    }
  }, [canvasRef, resolvedTheme])
}

function NetworkMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useMapCanvas(canvasRef)

  return (
    <div className="vryx-map" aria-label="Globe 3D interactif du réseau VRYX">
      <canvas ref={canvasRef} className="vryx-map-canvas" aria-hidden />
    </div>
  )
}

function ModelLogo({ id }: { id: ModelLogoId }) {
  return (
    <svg className="vryx-model-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {logoGlyphs[id]}
    </svg>
  )
}

function AppleLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 25" fill="currentColor" aria-hidden>
      <path d="M16.37 1.43c0 1.1-.45 2.12-1.22 2.9-.83.84-1.93 1.35-3 1.26-.13-1.04.39-2.16 1.16-2.96.82-.84 2.1-1.48 3.06-1.2Zm3.42 16.67c-.6 1.38-.9 2-1.67 3.22-1.08 1.66-2.6 3.73-4.49 3.75-1.68.02-2.11-1.09-4.39-1.08-2.28.01-2.76 1.1-4.44 1.08-1.89-.02-3.33-1.88-4.41-3.54-3-4.6-3.32-10-.02-12.88 1.17-1.02 2.75-1.62 4.23-1.64 1.66-.03 3.23 1.12 4.25 1.12 1.02 0 2.94-1.38 4.96-1.18.84.03 3.22.34 4.75 2.58-4.18 2.3-3.5 8.21 1.23 8.57Z" />
    </svg>
  )
}

function WindowsLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 4.8 10.8 3.7v7.55H3V4.8Zm9-1.25L21 2.25v9h-9V3.55ZM3 12.75h7.8v7.55L3 19.2v-6.45Zm9 0h9v9l-9-1.25v-7.75Z" />
    </svg>
  )
}

type DownloadTarget = {
  href: string
  label: string
  platform: 'macos' | 'windows'
}

const macDownload: DownloadTarget = {
  href: '/downloads/Vryx-Worker-latest-mac.zip',
  label: 'Télécharger pour macOS',
  platform: 'macos',
}

const windowsDownload: DownloadTarget = {
  href: '/downloads/Vryx-Worker-Setup-latest-x64.exe',
  label: 'Télécharger pour Windows',
  platform: 'windows',
}

function resolveDownloadTarget(): DownloadTarget {
  if (typeof navigator === 'undefined') return macDownload
  const userAgent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  return userAgent.includes('windows') || userAgent.includes('win32') || userAgent.includes('win64')
    ? windowsDownload
    : macDownload
}

function useDownloadTarget() {
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget>(macDownload)

  useEffect(() => {
    setDownloadTarget(resolveDownloadTarget())
  }, [])

  return downloadTarget
}

type GpuPreset = {
  name: string
  vram: string
  monthlyEstimate: number
  earnRate: number
}

const GPU_PRESETS: GpuPreset[] = [
  { name: 'RTX 4090', vram: '24 Go GDDR6X', monthlyEstimate: 78.50, earnRate: 0.0000302 },
  { name: 'Apple M3 Max', vram: '48 Go Unified', monthlyEstimate: 62.10, earnRate: 0.0000238 },
  { name: 'RTX 4080', vram: '16 Go GDDR6X', monthlyEstimate: 48.20, earnRate: 0.0000185 },
  { name: 'RTX 3080', vram: '10 Go GDDR6X', monthlyEstimate: 29.40, earnRate: 0.0000113 },
]

function MonetizeSection() {
  const { resolvedTheme } = useTheme()
  const isLight = resolvedTheme === 'light'
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  
  const [selectedGpu, setSelectedGpu] = useState<GpuPreset>(GPU_PRESETS[0])
  const [earnings, setEarnings] = useState(0.0)

  // Live earning counter
  useEffect(() => {
    const interval = setInterval(() => {
      setEarnings(prev => prev + selectedGpu.earnRate * (0.8 + Math.random() * 0.4))
    }, 120)
    return () => clearInterval(interval)
  }, [selectedGpu])

  // Canvas particle animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = canvas.width = canvas.offsetWidth
    let height = canvas.height = canvas.offsetHeight

    const handleResize = () => {
      if (!canvas) return
      width = canvas.width = canvas.offsetWidth
      height = canvas.height = canvas.offsetHeight
    }
    window.addEventListener('resize', handleResize)

    // Particles representing GPU nodes in the network
    type GpuParticle = {
      x: number
      y: number
      vx: number
      vy: number
      size: number
      label: string
      pulse: number
      color: string
    }

    const gpuLabels = ['RTX 4090', 'H100 PCIe', 'RTX 3090', 'RX 7900 XTX', 'Apple M3 Max', 'A100 SXM', 'RTX 4080', 'L40S']
    const particles: GpuParticle[] = []
    
    // Create particles
    for (let i = 0; i < 15; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: Math.random() * 4 + 2,
        label: gpuLabels[i % gpuLabels.length],
        pulse: Math.random() * Math.PI,
        color: i % 3 === 0 ? '#06b6d4' : (i % 3 === 1 ? '#8b5cf6' : '#4f46e5')
      })
    }

    let mouse = { x: -9999, y: -9999 }
    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      mouse.x = e.clientX - rect.left
      mouse.y = e.clientY - rect.top
    }
    const onMouseLeave = () => {
      mouse.x = -9999
      mouse.y = -9999
    }
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    let animationId: number

    const render = () => {
      ctx.clearRect(0, 0, width, height)

      // Draw connection lines
      for (let i = 0; i < particles.length; i++) {
        const p1 = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j]
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist < 150) {
            const alpha = (1 - dist / 150) * 0.15
            ctx.strokeStyle = isLight ? `rgba(99, 102, 241, ${alpha})` : `rgba(6, 182, 212, ${alpha})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
            ctx.stroke()
          }
        }
      }

      // Draw particles & labels
      particles.forEach((p) => {
        p.x += p.vx
        p.y += p.vy
        p.pulse += 0.015

        // Bounce walls
        if (p.x < 0 || p.x > width) p.vx *= -1
        if (p.y < 0 || p.y > height) p.vy *= -1

        // Mouse attraction
        if (mouse.x !== -9999) {
          const mdx = mouse.x - p.x
          const mdy = mouse.y - p.y
          const mdist = Math.sqrt(mdx * mdx + mdy * mdy)
          if (mdist < 180) {
            const force = (1 - mdist / 180) * 0.12
            p.x += (mdx / mdist) * force
            p.y += (mdy / mdist) * force
          }
        }

        const currentSize = p.size + Math.sin(p.pulse) * 1.5

        // Glow ring
        ctx.fillStyle = p.color
        ctx.globalAlpha = 0.15 + Math.sin(p.pulse) * 0.05
        ctx.beginPath()
        ctx.arc(p.x, p.y, currentSize * 2.5, 0, Math.PI * 2)
        ctx.fill()

        // Core dot
        ctx.globalAlpha = 0.8
        ctx.beginPath()
        ctx.arc(p.x, p.y, currentSize, 0, Math.PI * 2)
        ctx.fill()

        // Label
        ctx.fillStyle = isLight ? '#4a5568' : '#a4b1c6'
        ctx.font = '600 9px monospace'
        ctx.textAlign = 'center'
        ctx.globalAlpha = 0.45 + Math.sin(p.pulse) * 0.15
        ctx.fillText(p.label, p.x, p.y - currentSize - 5)
      })

      ctx.globalAlpha = 1
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', handleResize)
      if (canvas) {
        canvas.removeEventListener('mousemove', onMouseMove)
        canvas.removeEventListener('mouseleave', onMouseLeave)
      }
    }
  }, [isLight])

  return (
    <section className="vryx-monetize-wrap" aria-labelledby="monetize-heading">
      <motion.div
        className="vryx-monetize-card"
        initial={{ opacity: 0, y: 70 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-120px" }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Background Canvas */}
        <canvas ref={canvasRef} className="vryx-monetize-canvas" />

        {/* Content Overlay */}
        <div className="vryx-monetize-grid">
          {/* Left Panel: Info & Marketing */}
          <div className="vryx-monetize-left">
            <h2 id="monetize-heading">Monétisez vos GPU</h2>
            <p className="vryx-monetize-desc">
              Louez la puissance de calcul inutilisée de votre carte graphique au premier réseau DePIN d'inférence d'IA décentralisé. Recevez des récompenses directes en temps réel, sans aucune friction.
            </p>

            <ul className="vryx-monetize-features">
              <li>
                <div>
                  <strong>Zéro Friction</strong>
                  <p>Un simple client desktop (macOS & Windows) à lancer en arrière-plan en un clic.</p>
                </div>
              </li>
              <li>
                <div>
                  <strong>Sécurité Absolue</strong>
                  <p>Inférence isolée par shards en RAM. Vos fichiers et données personnelles restent intouchables.</p>
                </div>
              </li>
              <li>
                <div>
                  <strong>Rémunération Équitable</strong>
                  <p>Revenus basés sur la VRAM allouée et la quantité de calculs effectifs traités.</p>
                </div>
              </li>
            </ul>

            <Link className="vryx-button vryx-button-primary mt-6" to="/workers">
              Devenir Worker Vryx
              <span aria-hidden>→</span>
            </Link>
          </div>

          {/* Right Panel: Interactive Simulator Widget */}
          <div className="vryx-monetize-right">
            <div className="vryx-simulator-widget">
              {/* Selector */}
              <div className="gpu-selector-wrap">
                <label className="selector-label">Choisissez votre matériel :</label>
                <div className="gpu-presets-grid">
                  {GPU_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => {
                        setSelectedGpu(preset)
                        setEarnings(0.0)
                      }}
                      className={`preset-btn ${selectedGpu.name === preset.name ? 'active' : ''}`}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Counter Display */}
              <div className="live-earnings-wrap">
                <div className="earnings-label">REVENUS ESTIMÉS</div>
                <div className="earnings-amount">
                  <code>{earnings.toFixed(5)}</code>
                  <span className="currency">€</span>
                </div>
              </div>

              {/* Quick Specs */}
              <div className="widget-specs">
                <div className="spec-row">
                  <span>Mémoire VRAM allouée :</span>
                  <strong>{selectedGpu.vram}</strong>
                </div>
                <div className="spec-row">
                  <span>Revenus est. mensuels :</span>
                  <strong className="text-highlight">~ {selectedGpu.monthlyEstimate.toFixed(2)} €</strong>
                </div>
                <div className="spec-row">
                  <span>Type de charge :</span>
                  <span>Inférence Shard TP (gRPC)</span>
                </div>
              </div>

              <div className="widget-footer">
                * Les gains varient selon la demande globale et le temps de disponibilité effectif.
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  )
}

export function VryxLandingExperience() {
  const heroCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const wordCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const downloadTarget = useDownloadTarget()
  useHeroCanvases(heroCanvasRef, wordCanvasRef)

  return (
    <div className="vryx-landing">
      <section className="vryx-hero" aria-labelledby="hero-heading">
        <canvas ref={heroCanvasRef} className="vryx-hero-canvas" aria-hidden />

        <div className="vryx-hero-core">
          <div className="vryx-word" aria-hidden>
            <canvas ref={wordCanvasRef} />
          </div>
          <h1 id="hero-heading" className="sr-only">
            VRYX, réseau P2P pour exécuter l’IA sur des GPU distribués
          </h1>
          <p className="vryx-hero-copy">
            Le calcul IA devient fluide, mondial et programmable.
          </p>
          <div className="vryx-actions">
            <a className="vryx-button vryx-button-primary" href={downloadTarget.href}>
              {downloadTarget.platform === 'windows' ? (
                <WindowsLogo className="vryx-button-icon" />
              ) : (
                <AppleLogo className="vryx-button-icon" />
              )}
              {downloadTarget.label}
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>

      <MonetizeSection />

      <main className="vryx-landing-main">
        <section id="product" className="vryx-product" aria-labelledby="product-heading">
          <div className="vryx-section-heading">
            <p>Conçu pour l’échelle</p>
            <h2 id="product-heading">Une nouvelle façon de faire tourner l’IA</h2>
          </div>
          <div className="vryx-feature-grid">
            {features.map((feature) => (
              <article className="vryx-feature-card" key={feature.kind}>
                <div className="vryx-feature-stage">
                  <IconCanvas kind={feature.kind} color={feature.color} />
                </div>
                <div className="vryx-feature-copy">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
                <div className="vryx-card-wave" style={{ '--wave': feature.color } as CSSProperties} aria-hidden />
              </article>
            ))}
          </div>
        </section>

        <section id="network" className="vryx-network" aria-labelledby="network-heading">
          <div className="vryx-network-copy">
            <p className="vryx-mini-title">La puissance du P2P</p>
            <h2 id="network-heading">Le monde devient ta puissance de calcul.</h2>
            <p>
              VRYX rassemble des GPU dormants, vérifie leur disponibilité et route les charges IA vers la bonne
              capacité au bon moment.
            </p>
            <Link className="vryx-button vryx-button-secondary" to="/network">
              Explorer le réseau
              <span aria-hidden>→</span>
            </Link>
          </div>
          <NetworkMap />
        </section>

        <section id="workers" className="vryx-worker-strip" aria-labelledby="workers-home-heading">
          <div>
            <p className="vryx-mini-title">Nœuds</p>
            <h2 id="workers-home-heading">Chaque GPU peut rejoindre le réseau.</h2>
          </div>
          <p>
            Les nœuds apportent de la capacité, VRYX orchestre la qualité de service, la sécurité d’exécution et la
            mesure de contribution.
          </p>
          <Link className="vryx-button vryx-button-primary" to="/workers">
            Devenir nœud
            <span aria-hidden>→</span>
          </Link>
        </section>

        <section className="vryx-logo-cloud" aria-labelledby="logo-cloud-heading">
          <h2 id="logo-cloud-heading">Compatible avec les piles IA modernes</h2>
          <div className="vryx-logo-row">
            {logos.map((logo, index) => (
              <div
                className="vryx-logo-tile"
                key={`${logo.id}-${index}`}
                role="img"
                aria-label={logo.alt}
                style={
                  {
                    '--logo-delay': `${index * 0.16}s`,
                    '--logo-depth': `${Math.sin(index * 0.9) * 0.22 + 1}`,
                    '--logo-y': `${Math.sin(index * 0.82) * 0.75}rem`,
                  } as CSSProperties
                }
              >
                <ModelLogo id={logo.id} />
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
