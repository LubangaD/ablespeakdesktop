/**
 * Speech profile — how well AbleSpeak hears one student, and the settings
 * that help (sensitivity, pause length, their words, shortcuts, routines).
 * Opens on the student at this computer unless another is chosen.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AudioLines } from 'lucide-react';
import { api } from '../lib/api';
import { RecognitionReadout, SpeechSettings } from '../components/StudentSpeech';
import { Field, Notice } from '../components/ui';

export default function SpeechProfile() {
  const [params, setParams] = useSearchParams();
  const { data: students = [], isLoading } = useQuery({
    queryKey: ['students'],
    queryFn: () => api.getStudents({ all: 1 }),
    staleTime: 30000,
  });
  const { data: active } = useQuery({ queryKey: ['activeStudent'], queryFn: api.getActiveStudent, refetchInterval: 15000 });

  const chosen = params.get('student') || (active?.student ? String(active.student.id) : '');
  const student = students.find(s => String(s.id) === chosen) || null;

  const choose = (e) => {
    const next = new URLSearchParams(params);
    if (e.target.value) next.set('student', e.target.value); else next.delete('student');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <header className="page-header with-aside">
        <div>
          <h2><AudioLines size={28} aria-hidden="true" /> Speech profile</h2>
          <p>How well AbleSpeak hears a student, and the settings that help.</p>
        </div>
        <Field id="speech-student" label="Student" className="header-field">
          <select id="speech-student" className="field-input" value={student ? String(student.id) : ''} onChange={choose}>
            <option value="">Choose a student</option>
            {students.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}{active?.student?.id === s.id ? ' (in session)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </header>

      {isLoading && <p className="muted-note">Loading students…</p>}

      {!isLoading && !student && (
        <Notice tone="info" title={students.length ? 'Choose a student' : 'No students yet'}>
          {students.length
            ? 'Pick a student above to see how well AbleSpeak hears them and change their speech settings.'
            : <>Add a student on the <Link className="text-link" to="/students">Students</Link> page first.</>}
        </Notice>
      )}

      {student && (
        <>
          <RecognitionReadout studentId={student.id} />
          <SpeechSettings key={student.id} studentId={student.id} studentName={student.name} />
        </>
      )}
    </div>
  );
}
