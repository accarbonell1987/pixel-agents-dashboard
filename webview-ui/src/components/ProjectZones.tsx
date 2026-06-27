import { useState, useEffect } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import { TILE_SIZE } from '../office/types.js'

interface ProjectZonesProps {
  officeState: OfficeState
  agents: number[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
}

interface Zone {
  name: string
  color: string
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Translucent colored floor + banner around each project's clustered agents.
 *  Reads live character positions, so it follows agents as they move/sit. */
export function ProjectZones({ officeState, agents, containerRef, zoom, panRef }: ProjectZonesProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  // Bounding box (in world pixels) of each project's agents.
  const zones = new Map<string, Zone>()
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (!ch?.projectName || !ch.projectColor) continue
    const z = zones.get(ch.projectName)
    if (!z) {
      zones.set(ch.projectName, { name: ch.projectName, color: ch.projectColor, minX: ch.x, minY: ch.y, maxX: ch.x, maxY: ch.y })
    } else {
      z.minX = Math.min(z.minX, ch.x)
      z.minY = Math.min(z.minY, ch.y)
      z.maxX = Math.max(z.maxX, ch.x)
      z.maxY = Math.max(z.maxY, ch.y)
    }
  }
  if (zones.size === 0) return null

  const pad = TILE_SIZE * 1.2
  const toScreenX = (worldX: number) => (deviceOffsetX + worldX * zoom) / dpr
  const toScreenY = (worldY: number) => (deviceOffsetY + worldY * zoom) / dpr

  return (
    <>
      {[...zones.values()].map((z) => {
        const left = toScreenX(z.minX - pad)
        const top = toScreenY(z.minY - pad - TILE_SIZE) // extra room up top for the banner
        const width = ((z.maxX - z.minX) + pad * 2) * zoom / dpr
        const height = ((z.maxY - z.minY) + pad * 2 + TILE_SIZE) * zoom / dpr
        return (
          <div
            key={z.name}
            style={{
              position: 'absolute',
              left,
              top,
              width,
              height,
              background: `${z.color}1F`,
              border: `2px solid ${z.color}99`,
              borderRadius: 6,
              pointerEvents: 'none',
              zIndex: 5,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: -2,
                left: 6,
                transform: 'translateY(-100%)',
                fontSize: 14,
                color: '#fff',
                background: `${z.color}E6`,
                padding: '1px 6px',
                borderRadius: 3,
                whiteSpace: 'nowrap',
                textShadow: '0 1px 2px rgba(0,0,0,0.9)',
              }}
            >
              {z.name}
            </span>
          </div>
        )
      })}
    </>
  )
}
