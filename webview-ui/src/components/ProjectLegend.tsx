import type { OfficeState } from '../office/engine/officeState.js'

interface ProjectLegendProps {
  officeState: OfficeState
  agents: number[] // re-render trigger when the roster changes
}

/** Top-left key mapping each project color to its name. Hidden until there are
 *  agents from 2+ projects — with a single project the color carries no info. */
export function ProjectLegend({ officeState, agents }: ProjectLegendProps) {
  const byName = new Map<string, string>()
  for (const id of agents) {
    const ch = officeState.characters.get(id)
    if (ch?.projectName && ch.projectColor) byName.set(ch.projectName, ch.projectColor)
  }
  if (byName.size < 2) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 10px',
        background: 'rgba(20,20,30,0.82)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 4,
        pointerEvents: 'none',
        zIndex: 50,
      }}
    >
      {[...byName.entries()].map(([name, color]) => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: color, flexShrink: 0 }} />
          <span style={{ fontSize: 14, color: '#fff', whiteSpace: 'nowrap' }}>{name}</span>
        </div>
      ))}
    </div>
  )
}
