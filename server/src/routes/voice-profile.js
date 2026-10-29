/**
 * "My voice" on the Voice & words page (voice-profile.js): setting up a
 * person's voiceprint, and deleting it. Only from AbleSpeak's own pages on
 * this computer, since what is sent here is the person's voice.
 *
 * Who may set up which voice:
 * - before anyone has, the person signed in sets up their own and becomes
 *   the owner;
 * - after that, the owner may redo their own or add someone else's, and a
 *   person already set up may redo their own;
 * - an admin may do any of it.
 * A voice can be deleted by the person, the owner or an admin.
 */
import { Router } from 'express';
import { isFromThisComputer } from './settings.js';
import { fromOwnPages } from '../admin-pin.js';
import { ENROLL_PHRASES, MIN_CLIPS, MATCH_THRESHOLD, VoiceProfileError, summarizeChecks } from '../voice-profile.js';

/**
 * `speakerChecks(id)`: the person's latest voice checks, newest first.
 * `captureFor(id)`: how their microphone is opened, to record the phrases the
 * way the voice bar hears commands. `onChange()`: a voice was added, removed,
 * or is being set up.
 */
export function createVoiceProfileRouter({
  profiles, activeStudent, getStudent, getStudents, addStudent, requestRole, speakerChecks, captureFor, onChange = () => {},
}) {
  const router = Router();
  router.use((req, res, next) => {
    if (isFromThisComputer(req) && fromOwnPages(req)) return next();
    res.status(403).json({ error: 'Voices can only be set up from the AbleSpeak dashboard on this computer.' });
  });

  const nameOf = id => getStudent(id)?.name || 'someone';

  function rights(req) {
    const admin = requestRole(req) === 'admin';
    const me = activeStudent()?.id ?? null;
    const owner = profiles.owner();
    return { admin, me, owner, manager: admin || (me != null && owner === me) };
  }

  /** Why this request can't set up `id`'s voice, or null if it can. */
  function cannotEnroll(req, id) {
    const { me, owner, manager } = rights(req);
    if (manager) return null;
    if (me == null) return 'Nobody is signed in. An admin can add a voice.';
    if (id === me && (owner == null || profiles.has(me))) return null;
    if (owner == null) return 'Set up your own voice first: the first voice set up looks after the others.';
    return id === me
      ? `Ask ${nameOf(owner)}, who looks after the voices on this computer, or an admin to add yours.`
      : `Only ${nameOf(owner)} or an admin can add someone else's voice.`;
  }

  const target = req => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && getStudent(id) ? id : null;
  };

  const handle = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof VoiceProfileError)) console.warn('[Voice lock]', err.message);
      res.status(err instanceof VoiceProfileError ? err.status : 500).json({ error: err.message });
    }
  };

  // GET /api/voice-profile?student=<id> — the person signed in, or (for the owner or an admin) anyone
  router.get('/', (req, res) => {
    const { me, owner, manager } = rights(req);
    const asked = req.query.student != null && req.query.student !== '' ? Number(req.query.student) : me;
    const id = Number.isInteger(asked) ? asked : null;
    if (id !== me && !manager) return res.status(403).json({ error: 'Only the owner or an admin can see other voices.' });
    const student = id != null ? getStudent(id) : null;
    const voice = student ? profiles.describe(id) : null;
    const why = student ? cannotEnroll(req, id) : 'Nobody is signed in. An admin can add a voice.';
    res.json({
      model: profiles.model(),
      phrases: ENROLL_PHRASES,
      minClips: MIN_CLIPS,
      threshold: MATCH_THRESHOLD,
      owner: owner == null ? null : { id: owner, name: nameOf(owner), you: owner === me },
      person: student ? {
        id, name: student.name, you: id === me, voice,
        measured: voice ? summarizeChecks(speakerChecks(id), id) : null,
      } : null,
      canEnroll: !why,
      why,
      canManage: manager,
      people: manager ? profiles.people().map(p => ({ ...p, name: nameOf(p.id) })) : null,
      enrolling: profiles.enrolling(),
      capture: student ? captureFor(id) : null,
    });
  });

  // POST /api/voice-profile/people { name } — the owner or an admin adds someone, to set up their voice
  router.post('/people', (req, res) => {
    if (!rights(req).manager) return res.status(403).json({ error: 'Only the owner or an admin can add someone.' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) return res.status(400).json({ error: 'Type their name, up to 80 letters.' });
    const student = getStudents().find(s => s.name.toLowerCase() === name.toLowerCase()) || addStudent({ name });
    res.status(201).json({ student });
  });

  // POST /api/voice-profile/:id/start { agree, adult, guardian } — consent, then the phrases
  router.post('/:id/start', handle((req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    const why = cannotEnroll(req, id);
    if (why) return res.status(403).json({ error: why });
    const { agree, adult, guardian } = req.body || {};
    if (agree !== true) return res.status(400).json({ error: 'A voice is only set up with consent.' });
    if (adult !== true && guardian !== true) return res.status(400).json({ error: 'Under 18, a parent or guardian needs to agree.' });
    const enrolling = profiles.start(id, { by: adult === true ? 'self' : 'guardian' });
    onChange();
    res.status(201).json({ enrolling });
  }));

  // POST /api/voice-profile/:id/clips { wav, phrase } — one phrase read aloud (16 kHz WAV, base64)
  router.post('/:id/clips', handle(async (req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    const phrase = Number(req.body?.phrase);
    if (!Number.isInteger(phrase) || phrase < 0 || phrase >= ENROLL_PHRASES.length) return res.status(400).json({ error: 'Which phrase was that?' });
    if (typeof req.body?.wav !== 'string') return res.status(400).json({ error: 'No recording came with it.' });
    res.json(await profiles.addClip(id, { wav: req.body.wav, phrase }));
  }));

  // POST /api/voice-profile/:id/room { wav } — half a minute of the person's usual room
  router.post('/:id/room', handle((req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    if (typeof req.body?.wav !== 'string') return res.status(400).json({ error: 'No recording came with it.' });
    res.json(profiles.addRoom(id, { wav: req.body.wav }));
  }));

  // POST /api/voice-profile/:id/keep — the setup page is still open (voice commands stay paused)
  router.post('/:id/keep', handle((req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    res.json({ enrolling: profiles.keep(id) });
  }));

  // POST /api/voice-profile/:id/finish — make and keep the voiceprint
  router.post('/:id/finish', handle(async (req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    const voice = await profiles.finish(id);
    onChange();
    res.json({ voice, owner: profiles.owner() });
  }));

  // DELETE /api/voice-profile/:id/enrollment — stop setting it up; nothing is kept
  router.delete('/:id/enrollment', (req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    profiles.cancel(id);
    onChange();
    res.json({ cancelled: true });
  });

  // DELETE /api/voice-profile/:id — delete a voiceprint
  router.delete('/:id', handle(async (req, res) => {
    const id = target(req);
    if (id == null) return res.status(404).json({ error: 'User not found' });
    const { admin, me, owner } = rights(req);
    if (!(admin || id === me || (me != null && owner === me))) {
      return res.status(403).json({ error: 'Only the person, the owner or an admin can delete a voice.' });
    }
    const deleted = await profiles.remove(id);
    onChange();
    res.json({ deleted, owner: profiles.owner() });
  }));

  return router;
}
