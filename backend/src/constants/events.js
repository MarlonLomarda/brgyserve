// Canonical vocabularies for the Events & Activities module.
//
// One table, two record kinds (migration 013):
//   activity      a real timed event — start/end REQUIRED, end after start
//   announcement  an informational notice — start/end/location OPTIONAL
//
// Display status is DERIVED from the type and the clock, never stored (same
// approach as rental derived statuses): an activity is upcoming/ongoing/past
// depending on now vs its window; an announcement is simply 'posted'.

const EVENT_TYPE = {
  ANNOUNCEMENT: 'announcement',
  ACTIVITY: 'activity',
};
const EVENT_TYPES = Object.values(EVENT_TYPE);

const EVENT_STATUS = {
  POSTED: 'posted', // announcements
  UPCOMING: 'upcoming', // activity, not started
  ONGOING: 'ongoing', // activity, in progress
  PAST: 'past', // activity, finished
};

// List views. 'active' hides finished activities automatically — that is pure
// filtering on end_datetime vs now, NOT a real archive: is_archived is never
// flipped by the passage of time and there is no scheduled job.
const EVENT_VIEW = {
  ACTIVE: 'active',
  PAST: 'past',
  ARCHIVED: 'archived',
  ALL: 'all',
};
const EVENT_VIEWS = Object.values(EVENT_VIEW);

module.exports = { EVENT_TYPE, EVENT_TYPES, EVENT_STATUS, EVENT_VIEW, EVENT_VIEWS };
