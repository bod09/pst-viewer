import type { ReactNode } from 'react'
import type { AppointmentCard, ContactCard, DistListCard } from '../types'
import { formatDate } from '../lib/format'

function dateOnly(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function withProtocol(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`
}

function timeRange(start: number | null, end: number | null, allDay: boolean): string {
  if (start == null) return ''
  if (allDay) {
    const s = dateOnly(start)
    const e = end != null ? dateOnly(end) : ''
    return e && e !== s ? `${s} to ${e}` : `${s} (all day)`
  }
  const s = formatDate(start)
  return end != null ? `${s} to ${formatDate(end)}` : s
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-slate-200">{children}</span>
    </div>
  )
}

/** A contact item (IPM.Contact) shown as a card, with its note if present. */
export function ContactCardView({
  contact,
  notes,
}: {
  contact: ContactCard
  notes?: string | null
}) {
  const subtitle = [contact.jobTitle, contact.company].filter(Boolean).join(', ')
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-xl font-semibold text-slate-100">
          {contact.fullName || '(unnamed contact)'}
        </h2>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        <div className="mt-4 divide-y divide-slate-800/70">
          {contact.emails.map((e, i) => (
            <Row key={`e${i}`} label={i === 0 ? 'Email' : e.label}>
              <a href={`mailto:${e.address}`} className="text-sky-400 hover:underline">
                {e.address}
              </a>
            </Row>
          ))}
          {contact.phones.map((p, i) => (
            <Row key={`p${i}`} label={p.label}>
              {p.value}
            </Row>
          ))}
          {contact.im && <Row label="IM">{contact.im}</Row>}
          {contact.department && <Row label="Department">{contact.department}</Row>}
          {contact.addresses.map((a, i) => (
            <Row key={`a${i}`} label={`${a.label} address`}>
              <span className="whitespace-pre-wrap">{a.value}</span>
            </Row>
          ))}
          {contact.website && (
            <Row label="Website">
              <a
                href={withProtocol(contact.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 hover:underline"
              >
                {contact.website}
              </a>
            </Row>
          )}
          {contact.birthday != null && <Row label="Birthday">{dateOnly(contact.birthday)}</Row>}
        </div>
        {notes && notes.trim() && (
          <div className="mt-4 border-t border-slate-800/70 pt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{notes}</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Appointment/meeting (IPM.Appointment) metadata, shown above the body (notes). */
export function AppointmentCardView({ appointment }: { appointment: AppointmentCard }) {
  const when = timeRange(appointment.start, appointment.end, appointment.allDay)
  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-6 py-4">
      <div className="space-y-0.5">
        {when && <Row label="When">{when}</Row>}
        {appointment.location && <Row label="Where">{appointment.location}</Row>}
        {appointment.organizer && <Row label="Organizer">{appointment.organizer}</Row>}
        {appointment.requiredAttendees && (
          <Row label="Required">{appointment.requiredAttendees}</Row>
        )}
        {appointment.optionalAttendees && (
          <Row label="Optional">{appointment.optionalAttendees}</Row>
        )}
        {appointment.recurrence && <Row label="Recurrence">{appointment.recurrence}</Row>}
      </div>
    </div>
  )
}

/** A distribution list / contact group (IPM.DistList) shown as a card. */
export function DistListCardView({
  distlist,
  notes,
}: {
  distlist: DistListCard
  notes?: string | null
}) {
  const n = distlist.members.length
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
        <h2 className="text-xl font-semibold text-slate-100">
          {distlist.name || '(unnamed group)'}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Distribution list{n > 0 ? `, ${n} member${n === 1 ? '' : 's'}` : ''}
        </p>
        {n > 0 && (
          <ul className="mt-4 divide-y divide-slate-800/70">
            {distlist.members.map((mem, i) => (
              <li key={i} className="flex flex-col py-2">
                {mem.name && <span className="text-sm text-slate-200">{mem.name}</span>}
                {mem.email && (
                  <a href={`mailto:${mem.email}`} className="text-sm text-sky-400 hover:underline">
                    {mem.email}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {notes && notes.trim() && (
          <div className="mt-4 border-t border-slate-800/70 pt-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{notes}</p>
          </div>
        )}
      </div>
    </div>
  )
}
