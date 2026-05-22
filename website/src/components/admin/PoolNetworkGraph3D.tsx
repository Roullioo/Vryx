import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import type { PoolGraphLink, PoolGraphNode } from './PoolNetworkGraph'

export type PoolNetworkGraph3DProps = {
  commonProps: Record<string, unknown>
  hueFromString: (value: string) => number
  persistPositions: () => void
}

export function PoolNetworkGraph3D({
  commonProps,
  hueFromString,
  persistPositions,
}: PoolNetworkGraph3DProps) {
  return (
    <ForceGraph3D<PoolGraphNode, PoolGraphLink>
      {...commonProps}
      nodeThreeObject={(node: PoolGraphNode) => {
        const hue = hueFromString(node.group || '')
        const size = Math.max(3, Math.cbrt(Number(node.val) || 1) * 2.5)
        return new THREE.Mesh(
          new THREE.SphereGeometry(size, 18, 18),
          new THREE.MeshLambertMaterial({
            color:
              node.status === 'timeout'
                ? 0xf97316
                : node.status === 'computing'
                  ? 0x5eead4
                  : new THREE.Color().setHSL(((hue % 360) / 360 + 1) % 1, 0.65, 0.55),
            transparent: true,
            opacity: 0.92,
          }),
        )
      }}
      nodeThreeObjectExtend={false}
      linkOpacity={0.35}
      onEngineStop={persistPositions}
    />
  )
}
