/**
 * String externalization (plan §8.10). Deliberately dependency-free: a typed
 * dictionary in the same nested shape as i18next resources, so adopting the
 * library later is a mechanical swap. Adding Bangla = translating `en` into a
 * `bn` object of the same type and switching on a setting.
 *
 * Rule: no user-facing static string lives in a component. Dynamic values are
 * interpolated by the caller.
 */

export const en = {
  app: {
    title: 'MeetFroge',
    tabRecord: 'Record',
    tabLibrary: 'Library',
    tabSettings: 'Settings',
    rec: '● REC',
    paused: '⏸ PAUSED',
  },
  setup: {
    heading: 'Sources',
    meetingTitle: 'Meeting title',
    meetingTitlePlaceholder: 'Weekly sync',
    screen: 'Screen / window',
    camera: 'Camera',
    microphone: 'Microphone',
    none: 'None',
    virtualSuffix: ' (virtual)',
    unavailableSuffix: ' — unavailable to recorder',
    systemAudio: 'Capture system audio (what you hear)',
    quality: 'Quality',
    qualityEfficient: 'Efficient — 720p10, smallest files',
    qualityBalanced: 'Balanced — 1080p15 (recommended)',
    qualityHigh: 'High — 1080p30',
    qualityArchival: 'Archival — native, largest files',
    refreshDevices: 'Refresh devices',
    screenOption: (n: number) => `Screen ${n}`,
  },
  preview: {
    heading: 'Preview',
    screenLabel: 'This screen/window will be recorded — the transcript, visual analysis and summary all come from it.',
    noScreen: 'No screen selected — only the camera/audio will be recorded.',
    mic: 'Mic',
    system: 'System',
    estimate: (perHour: string, free: string) => `≈ ${perHour}/hour · ${free} free`,
  },
  controls: {
    checkSetup: 'Check setup',
    record: '● Record',
    pause: '⏸ Pause',
    resume: '▶ Resume',
    stop: '■ Stop',
    dropWarning: (n: number) => `⚠ ${n} audio frames dropped`,
  },
  library: {
    meetings: 'Meetings',
    sourcePrefix: 'Source: ',
    searchAll: 'Search all meetings (speech + on-screen text)',
    searchAllAria: 'Search all meetings, speech and on-screen text',
    searchTranscript: 'Search this transcript…',
    searchTranscriptAria: 'Search within this transcript',
    noRecordings: 'No recordings yet. Record one from the Record tab.',
    noMatches: 'No matches.',
    recovered: ' recovered',
    transcribe: 'transcribe',
    tags: 'tags',
    tagsPrompt: 'Tags (comma-separated):',
    delete: 'delete',
    deleteConfirm: (title: string, size: string) =>
      `Delete "${title}" and its recording (${size})? This cannot be undone.`,
    viewSummary: 'Summary',
    viewTranscript: 'Transcript',
    selectMeeting: 'Select a meeting to view its transcript.',
    noTranscript: 'No transcript yet — processing may still be running, or press “transcribe”.',
    noSummary: 'No summary yet — it appears after processing finishes.',
    degradedSummary: '⚠ Structured summarization failed — showing merged raw notes.',
    keyPoints: 'Key points',
    decisions: 'Decisions',
    actionItems: 'Action items',
    openQuestions: 'Open questions',
    regenerate: 'Regenerate',
    renamePrompt: (name: string) => `Rename "${name}" to:`,
    speakerCertain: 'Identified from your microphone track (exact)',
    speakerDiarized: 'Diarized (probabilistic) — click to rename',
    jumpTo: 'Jump to this moment',
    exportCancelled: 'Export cancelled',
    exportSaved: (file: string) => `Saved ${file}`,
    playerAria:
      'Meeting recording playback. Shortcuts: space or K play-pause, J and L or arrows seek five seconds, up and down arrows change speed.',
    screenHit: 'SCREEN',
    speechHit: 'SPEECH',
  },
  settings: {
    loading: 'Loading…',
    recording: 'Recording',
    defaultQuality: 'Default quality',
    autoProcess: 'Process automatically when a recording stops',
    recordingsFolder: 'Recordings folder:',
    transcription: 'Transcription',
    language: 'Language',
    langEn: 'English (Bangla words transliterated — recommended for mixed speech)',
    langBn: 'Bangla',
    langAuto: 'Auto-detect (can flip mid-sentence on mixed speech)',
    banglishHint:
      'Mixed Bangla-English speech is the hardest case for every open model — accuracy is lower at language switch points. Transcripts are editable.',
    visual: 'Visual analysis',
    keyframeSensitivity: 'Keyframe sensitivity',
    kfSensitive: 'Sensitive — more keyframes, catches subtle changes',
    kfBalanced: 'Balanced (recommended)',
    kfSparse: 'Sparse — fewer keyframes, faster processing',
    models: 'Models',
    modelReady: '✓ ready',
    modelMissing: 'missing',
    modelCorrupt: '⚠ corrupt/partial',
    modelsHint:
      'Missing models make their pipeline stage skip (the rest still runs). The guided download flow arrives with the installer.',
    modelsFolder: 'Models folder:',
    saved: 'Saved',
  },
} as const

export type Strings = typeof en

/** The active dictionary. A `bn: Strings` translation switches here. */
export const t: Strings = en
