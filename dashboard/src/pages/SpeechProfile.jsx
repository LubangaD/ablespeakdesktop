/**
 * Voice & words — how well AbleSpeak hears the person signed in, and the
 * settings that help (sensitivity, pause length, their words, shortcuts,
 * routines). With the admin pages unlocked, another user can be chosen.
 * Laid out in the dashboard's everyday style (src/lib/ui.js).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { RecognitionReadout, SpeechSettings } from '../components/StudentSpeech';
import { TITLE, SECTION, MUTED, PAGE, CARD, PRIMARY, FIELD, INK } from '../lib/ui';

/** A Material Symbols icon, hidden from screen readers. */
function Icon({ name, className = '' }) {
  return <span className={`material-symbols-outlined ${className}`} aria-hidden="true">{name}</span>;
}

// A card for when there is nothing to show yet
function Prompt({ icon, title, children, action }) {
  return (
    <section aria-labelledby="speech-prompt-heading" className={`${CARD} p-5 flex items-start gap-3`}>
      <Icon name={icon} className="text-[20px] text-[#c9b8a5] mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col">
        <h2 id="speech-prompt-heading" className={SECTION}>{title}</h2>
        <p className={`${MUTED} mt-0.5`}>{children}</p>
        {action}
      </div>
    </section>
  );
}

export default function SpeechProfile() {
  const [params, setParams] = useSearchParams();
  // Shared with the sidebar, which refreshes it when the admin pages lock or unlock
  const { data: admin } = useQuery({ queryKey: ['adminStatus'], queryFn: api.getAdminStatus, refetchInterval: 30000 });
  const adminOpen = !!admin?.unlocked;
  const activeQuery = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });
  const me = activeQuery.data?.student || null;
  const { data: students = [], isLoading, error } = useQuery({
    queryKey: ['students'],
    queryFn: () => api.getStudents({ all: 1 }),
    staleTime: 30000,
    enabled: adminOpen,
  });

  // The person signed in sees their own; an admin may choose anyone
  const chosen = adminOpen ? (params.get('student') || (me ? String(me.id) : '')) : (me ? String(me.id) : '');
  const student = adminOpen ? students.find(s => String(s.id) === chosen) || null : me;
  const own = !!me && !!student && student.id === me.id;

  const choose = (e) => {
    const next = new URLSearchParams(params);
    if (e.target.value) next.set('student', e.target.value); else next.delete('student');
    setParams(next, { replace: true });
  };

  const noStudents = adminOpen && !isLoading && !error && students.length === 0;
  const loading = activeQuery.isPending || (adminOpen && isLoading);

  return (
    <div className={PAGE}>
      <div className="max-w-[1240px] w-full flex flex-col gap-6">
        <section aria-labelledby="page-title" className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className={TITLE} id="page-title">Voice &amp; words</h1>
            <p className={`${MUTED} text-[14px] mt-1`}>
              {own || !student ? 'How well AbleSpeak hears you, and the settings that help.' : `How well AbleSpeak hears ${student.name}, and the settings that help.`}
            </p>
          </div>
          {adminOpen && (
            <div className="w-72 max-w-full shrink-0">
              <label className="sr-only" htmlFor="student-select">User</label>
              <div className="relative">
                <select id="student-select" value={student ? String(student.id) : ''} onChange={choose}
                  disabled={isLoading || !!error || noStudents}
                  className={`${FIELD} focus:ring-0 bg-none appearance-none pr-10 cursor-pointer disabled:cursor-not-allowed disabled:text-[#c9b8a5]`}>
                  {isLoading && <option value="">Loading users…</option>}
                  {error && <option value="">Users not loaded</option>}
                  {noStudents && <option value="">No users yet</option>}
                  {students.length > 0 && <option value="">Choose a user</option>}
                  {students.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name}{me?.id === s.id ? ' (signed in)' : ''}
                    </option>
                  ))}
                </select>
                <div className="absolute inset-y-0 right-0 flex items-center px-3 pointer-events-none text-[#c9b8a5]">
                  <Icon name="expand_more" className="text-[20px]" />
                </div>
              </div>
            </div>
          )}
        </section>

        {adminOpen && error && (
          <p className={`text-[13px] leading-5 ${INK.bad}`} role="alert">Couldn't load the users: {error.message}</p>
        )}

        {!loading && !student && (
          !adminOpen ? (
            <Prompt icon="person" title="Nobody is signed in">
              Sign in to Windows and AbleSpeak opens your own voice settings and words here.
            </Prompt>
          ) : noStudents ? (
            <Prompt icon="group" title="No users yet"
              action={(
                <Link to="/students" className={`${PRIMARY} mt-4 self-start`}>
                  Go to Users
                </Link>
              )}>
              Add a user on the Users page first. Their voice settings appear here.
            </Prompt>
          ) : (
            <Prompt icon="record_voice_over" title="Choose a user">
              Choose a user in the list above to see how well AbleSpeak hears them and change their settings.
            </Prompt>
          )
        )}

        {student && (
          <>
            <RecognitionReadout studentId={student.id} studentName={own ? 'you' : student.name} />
            <SpeechSettings key={student.id} studentId={student.id} studentName={student.name} own={own} />
          </>
        )}
      </div>
    </div>
  );
}
