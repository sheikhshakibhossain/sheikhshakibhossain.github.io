/**
 * Track Me — Lecturer Availability Portal
 * shadcn/ui Inspired Black & White Theme Scheme
 */

(function () {
  'use strict';

  // --- Constants ---
  // Where appointment requests are addressed. The requester's own address is
  // added by their mail app, so the form never asks for it.
  const CONTACT_EMAIL = 'shakib@uiu.ac.bd';

  // --- State ---
  const state = {
    schedule: null,       // Loaded schedule.json
    timezone: 'Asia/Dhaka',
    selectedSlot: null,   // { day, slotKey, entry }
  };

  // --- DOM Elements ---
  const el = {
    themeBtn: document.getElementById('theme-btn'),
    themeIconLight: document.getElementById('theme-icon-light'),
    themeIconDark: document.getElementById('theme-icon-dark'),

    loadError: document.getElementById('load-error'),
    loadErrorMessage: document.getElementById('load-error-message'),

    todayStatus: document.getElementById('today-status'),
    statClasses: document.getElementById('stat-classes'),
    statSlots: document.getElementById('stat-slots'),
    statTimezone: document.getElementById('stat-timezone'),

    weekBadge: document.getElementById('week-badge'),
    scheduleList: document.getElementById('schedule-list'),

    slotList: document.getElementById('slot-list'),
    bookingForm: document.getElementById('booking-form'),
    bookingSummaryText: document.getElementById('booking-summary-text'),
    formNote: document.getElementById('form-note'),
    submitBtn: document.getElementById('submit-btn'),

    studentName: document.getElementById('student-name'),
    studentId: document.getElementById('student-id'),
    studentTopic: document.getElementById('student-topic'),

    toast: document.getElementById('toast-notification'),
    toastMsg: document.getElementById('toast-message'),
  };

  // --- Theme Management ---
  function initTheme() {
    const savedTheme = localStorage.getItem('theme-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    applyTheme(isDark);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme-mode')) {
        applyTheme(e.matches);
      }
    });
  }

  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.classList.add('dark');
      if (el.themeIconLight) el.themeIconLight.style.display = 'none';
      if (el.themeIconDark) el.themeIconDark.style.display = 'block';
    } else {
      document.documentElement.classList.remove('dark');
      if (el.themeIconLight) el.themeIconLight.style.display = 'block';
      if (el.themeIconDark) el.themeIconDark.style.display = 'none';
    }
  }

  function toggleTheme() {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    const nextDark = !isCurrentlyDark;
    applyTheme(nextDark);
    localStorage.setItem('theme-mode', nextDark ? 'dark' : 'light');
  }

  // --- Time helpers ---
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /**
   * Return the current day/time in the schedule's timezone.
   * Uses Intl so the browser converts from the user's local zone.
   */
  function nowInTimezone(timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date());

      const map = {};
      parts.forEach(p => { map[p.type] = p.value; });

      // Intl may render midnight as "24" in some engines.
      const hour = parseInt(map.hour, 10) % 24;
      const minute = parseInt(map.minute, 10);

      return {
        day: map.weekday,
        hours: hour,
        minutes: minute,
        minutesOfDay: hour * 60 + minute
      };
    } catch (err) {
      // Fall back to the browser's own zone if the timezone is unknown.
      const now = new Date();
      return {
        day: DAY_NAMES[now.getDay()],
        hours: now.getHours(),
        minutes: now.getMinutes(),
        minutesOfDay: now.getHours() * 60 + now.getMinutes()
      };
    }
  }

  /** "09:10" -> 550 */
  function toMinutes(time) {
    const [h, m] = String(time).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /** 550 -> "9:10 AM" */
  function formatTime12(time) {
    const total = toMinutes(time);
    let h = Math.floor(total / 60);
    const m = total % 60;
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
  }

  /** "09:00-10:00" -> "9:00 AM – 10:00 AM" */
  function formatSlotRange(slotKey) {
    const [start, end] = slotKey.split('-');
    return `${formatTime12(start)} – ${formatTime12(end)}`;
  }

  /**
   * A time range in the shortest form that still reads clearly.
   *
   * The repeated AM/PM on both ends is dropped when they match, so
   * "9:10 AM – 10:10 AM" becomes "9:10 – 10:10 AM". The hour strip above
   * the track makes the meridiem obvious anyway.
   */
  function formatTimeRange(startTime, endTime) {
    const start = formatTime12(startTime);
    const end = formatTime12(endTime);
    const startSuffix = start.slice(-2);
    const endSuffix = end.slice(-2);
    if (startSuffix === endSuffix) {
      return `${start.slice(0, -2).trim()} – ${end}`;
    }
    return `${start} – ${end}`;
  }

  // --- Entry labels ---
  function entryTitle(entry) {
    switch (entry.type) {
      case 'class':
        return `${entry.course_code} · Class`;
      case 'counseling':
        return 'Counseling';
      case 'office':
        return 'Office Hours';
      default:
        return 'Scheduled';
    }
  }

  function entrySubtitle(entry) {
    switch (entry.type) {
      case 'class':
        return `Section ${entry.section} · Room ${entry.room}`;
      case 'counseling':
        return entry.location || '';
      case 'office':
        return '';
      default:
        return '';
    }
  }

  function entryBadge(entry) {
    switch (entry.type) {
      case 'class':
        return { text: 'Class', cls: 'badge-class' };
      case 'counseling':
        return { text: 'Open', cls: 'badge-open' };
      case 'office':
        return { text: 'Office', cls: 'badge-office' };
      default:
        return { text: 'Busy', cls: '' };
    }
  }

  // --- Data loading ---
  async function loadSchedule() {
    try {
      const res = await fetch('schedule.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (!data || !data.schedule) throw new Error('Missing "schedule" key');

      state.schedule = data.schedule;
      state.timezone = data.timezone || 'Asia/Dhaka';

      render();
    } catch (err) {
      showLoadError(`Could not load schedule.json (${err.message}). Serve this folder over HTTP rather than opening the file directly.`);
    }
  }

  function showLoadError(message) {
    el.loadErrorMessage.textContent = message;
    el.loadError.hidden = false;
    el.scheduleList.innerHTML = '';
    el.slotList.innerHTML = '';
    el.weekBadge.textContent = 'Unavailable';
    el.bookingForm.hidden = true;
  }

  // --- Render ---
  function render() {
    renderTodayStats();
    renderWeek();
    renderSlots();
  }

  // The window the timeline track covers for every day.
  const DAY_START = 8 * 60;   // 08:00
  const DAY_END = 18 * 60;    // 18:00
  const DAY_SPAN = DAY_END - DAY_START;

  /**
   * Build a single row for one day: a horizontal track spanning the whole
   * day with one segment per scheduled activity, positioned by real clock
   * time so that long blocks and overlaps are shown truthfully.
   */
  function buildDayTimeline(day, slots, now) {
    const row = document.createElement('div');
    row.className = 'timeline-row';

    // Collect the activities for this day.
    const items = [];
    Object.entries(slots).forEach(([slotKey, entry]) => {
      if (!entry) return;
      items.push({
        slotKey,
        entry,
        start: toMinutes(entry.start_time),
        end: toMinutes(entry.end_time)
      });
    });

    // Lay overlapping activities out in separate lanes so both stay legible.
    const lanes = assignLanes(items);

    const track = document.createElement('div');
    track.className = 'timeline-track';

    // Hour ticks across the top of the track. Whole hours are labelled
    // without the minutes ("9 AM") so that neighbouring labels do not
    // touch each other.
    const ticks = document.createElement('div');
    ticks.className = 'timeline-ticks';
    for (let h = DAY_START / 60; h <= DAY_END / 60; h++) {
      const tick = document.createElement('span');
      tick.className = 'timeline-tick';
      tick.style.left = `${((h * 60 - DAY_START) / DAY_SPAN) * 100}%`;
      const hour12 = h % 12 === 0 ? 12 : h % 12;
      tick.textContent = `${hour12} ${h >= 12 ? 'PM' : 'AM'}`;
      ticks.appendChild(tick);
    }
    track.appendChild(ticks);

    // A dedicated area below the hour labels that holds the segments.
    const laneCount = Math.max(1, lanes.length);
    const laneArea = document.createElement('div');
    laneArea.className = 'timeline-lanes';
    laneArea.style.height = `${laneCount * SEGMENT_HEIGHT_PX}px`;
    track.appendChild(laneArea);

    // The track is as tall as the hour labels plus the lane area.
    track.style.height = `${TICKS_HEIGHT_PX + laneCount * SEGMENT_HEIGHT_PX + 6}px`;

    // The activity segments.
    lanes.forEach((lane, laneIndex) => {
      lane.forEach(item => {
        const seg = document.createElement('div');
        seg.className = `timeline-seg seg-${item.entry.type}`;
        seg.style.left = `${clampPct(item.start)}%`;
        seg.style.width = `${durationPct(item.end - item.start)}%`;
        seg.style.top = `${laneIndex * SEGMENT_HEIGHT_PX}px`;
        seg.style.height = `${SEGMENT_HEIGHT_PX - 6}px`;

        seg.setAttribute('role', 'listitem');
        seg.title = `${formatTime12(item.entry.start_time)} – ${formatTime12(item.entry.end_time)} · ${entryTitle(item.entry)}` +
          (entrySubtitle(item.entry) ? ` · ${entrySubtitle(item.entry)}` : '');

        // The time range, with the title underneath it. The timeline is the
        // only view now, so each segment has to carry both. The time comes
        // first because it is the part the segment's position does not
        // already show.
        const time = document.createElement('span');
        time.className = 'timeline-seg-time';
        time.textContent = formatTimeRange(item.entry.start_time, item.entry.end_time);
        seg.appendChild(time);

        const label = document.createElement('span');
        label.className = 'timeline-seg-label';
        label.textContent = entryTitle(item.entry);
        seg.appendChild(label);

        seg.dataset.label = entryTitle(item.entry);

        laneArea.appendChild(seg);
      });
    });

    // One "now" marker when the current day is being shown.
    if (day === now.day && now.minutesOfDay >= DAY_START && now.minutesOfDay <= DAY_END) {
      const marker = document.createElement('div');
      marker.className = 'timeline-now';
      marker.style.left = `${clampPct(now.minutesOfDay)}%`;
      marker.title = 'Current time';
      laneArea.appendChild(marker);
    }

    // The track sits in a scroll container so it can be swiped sideways
    // on a narrow screen instead of being squeezed into an unreadable
    // strip.
    const scroll = document.createElement('div');
    scroll.className = 'timeline-scroll';
    scroll.appendChild(track);
    row.appendChild(scroll);

    // A day with nothing scheduled just says so under the empty track.
    if (items.length === 0) {
      const note = document.createElement('div');
      note.className = 'day-free';
      note.textContent = 'No scheduled items — fully free.';
      row.appendChild(note);
    }

    return row;
  }

  // Height of one lane of activity segments, in pixels.
  const SEGMENT_HEIGHT_PX = 34;

  /**
   * Hide the parts of any timeline segment that are too narrow to show.
   *
   * The width of a segment depends on how wide the page is, so this has to
   * be measured after the browser has laid the schedule out rather than
   * guessed from the percentages. The title goes first; the time range is
   * always kept because it is the one thing the segment's position does
   * not already convey.
   */
  function trimSegmentLabels() {
    // A hidden element used to measure how wide a piece of text really is.
    // The label itself is clipped by CSS, so its own scrollWidth cannot be
    // trusted for this.
    const ruler = document.createElement('span');
    ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
    document.body.appendChild(ruler);

    const measure = (text, cls) => {
      ruler.className = cls;
      ruler.textContent = text;
      return ruler.getBoundingClientRect().width;
    };

    document.querySelectorAll('.timeline-seg').forEach(seg => {
      const label = seg.querySelector('.timeline-seg-label');
      const time = seg.querySelector('.timeline-seg-time');
      if (!label || !time) return;

      const segWidth = seg.clientWidth;
      const padding = 16; // the segment's horizontal padding plus borders
      const room = segWidth - padding;

      // Restore the full text before measuring, so repeated calls do not
      // keep shortening it.
      const full = seg.dataset.label || label.textContent;
      label.textContent = full;
      label.removeAttribute('title');
      seg.classList.remove('seg-compact', 'seg-narrow');

      // The time range must always fit. Fall back to shorter forms before
      // dropping it entirely.
      if (measure(time.textContent, 'timeline-seg-time') > room) {
        const short = time.textContent.replace(/\s*[AP]M/g, '');
        if (short !== time.textContent && measure(short, 'timeline-seg-time') <= room) {
          time.textContent = short;
        } else {
          const start = time.textContent.split(' – ')[0];
          if (measure(start, 'timeline-seg-time') <= room) {
            time.textContent = start;
          } else {
            seg.classList.add('seg-compact');
            return;
          }
        }
      }

      // The title is dropped when there is no room left for it.
      if (measure(full, 'timeline-seg-label') > room) {
        const short = full.replace(/\s*[·|].*$/, '').trim();
        if (short !== full && short.length > 0 && measure(short, 'timeline-seg-label') <= room) {
          label.textContent = short;
          label.title = full;
        } else {
          seg.classList.add('seg-compact');
        }
      }
    });

    ruler.remove();
  }

  // Height of the hour-label row at the top of the track, in pixels.
  const TICKS_HEIGHT_PX = 18;

  /** Position of a minute-of-day on the track, as a percentage. */
  function clampPct(minutes) {
    const pct = ((minutes - DAY_START) / DAY_SPAN) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  /** Width of a duration on the track, as a percentage of the whole day. */
  function durationPct(minutes) {
    return Math.max(0, Math.min(100, (minutes / DAY_SPAN) * 100));
  }

  /**
   * Split activities into lanes so that overlapping ones do not sit on top
   * of each other. Each lane holds activities that do not overlap.
   */
  function assignLanes(items) {
    const sorted = items.slice().sort((a, b) => a.start - b.start);
    const lanes = [];

    sorted.forEach(item => {
      let placed = false;
      for (const lane of lanes) {
        const last = lane[lane.length - 1];
        if (item.start >= last.end) {
          lane.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) lanes.push([item]);
    });

    return lanes;
  }

  function renderTodayStats() {
    const now = nowInTimezone(state.timezone);
    const daySchedule = state.schedule[now.day] || {};
    const entries = Object.values(daySchedule).filter(Boolean);

    const classCount = entries.filter(e => e.type === 'class').length;
    const counselingCount = entries.filter(e => e.type === 'counseling').length;
    const freeCount = Object.values(daySchedule).filter(v => v === null).length;

    el.statClasses.textContent = String(classCount).padStart(2, '0');
    el.statSlots.textContent = String(counselingCount).padStart(2, '0');
    el.statTimezone.textContent = 'UTC+6';
    el.statTimezone.classList.add('stat-text');

    const currentTime = formatTime12(
      `${String(now.hours).padStart(2, '0')}:${String(now.minutes).padStart(2, '0')}`
    );

    // Keep the day name in the badge so it is always clear which day the
    // numbers below belong to.
    let statusText;
    let statusClass;
    if (classCount > 0) {
      statusText = `${now.day} · ${currentTime} · Teaching`;
      statusClass = 'badge';
    } else if (counselingCount > 0) {
      statusText = `${now.day} · ${currentTime} · Available`;
      statusClass = 'badge';
    } else {
      statusText = `${now.day} · ${currentTime} · No classes today`;
      statusClass = 'badge badge-outline';
    }

    el.todayStatus.className = statusClass;
    el.todayStatus.textContent = statusText;
  }

  /**
   * The days of the week, ordered so the most relevant ones come first.
   *
   * The week starts on the day after today and ends on today itself, so the
   * days that are still ahead of us are at the top and today is at the
   * bottom. If today is not in the schedule, the natural order of the
   * schedule is kept.
   */
  function weekOrder(days, today) {
    const index = days.indexOf(today);
    if (index === -1) return days.slice();
    return days.slice(index + 1).concat(days.slice(0, index + 1));
  }

  function renderWeek() {
    const now = nowInTimezone(state.timezone);
    const days = weekOrder(Object.keys(state.schedule), now.day);
    let totalClasses = 0;
    let totalCounseling = 0;

    days.forEach(day => {
      Object.values(state.schedule[day]).forEach(entry => {
        if (!entry) return;
        if (entry.type === 'class') totalClasses++;
        if (entry.type === 'counseling') totalCounseling++;
      });
    });

    el.weekBadge.textContent = `${totalClasses} classes · ${totalCounseling} counseling slots`;

    const frag = document.createDocumentFragment();

    days.forEach(day => {
      const slots = state.schedule[day];
      const block = document.createElement('div');
      block.className = 'day-block';

      const heading = document.createElement('h3');
      heading.className = 'day-heading';

      const dayName = document.createElement('span');
      dayName.className = 'day-name';
      dayName.textContent = day;
      heading.appendChild(dayName);

      if (day === now.day) {
        const tag = document.createElement('span');
        tag.className = 'day-today';
        tag.textContent = 'Today';
        heading.appendChild(tag);
      }

      // A short summary of the day, so the card can be scanned without
      // reading the whole timeline.
      const entries = Object.values(slots).filter(Boolean);
      const classCount = entries.filter(e => e.type === 'class').length;
      const counselCount = entries.filter(e => e.type === 'counseling').length;
      const officeCount = entries.filter(e => e.type === 'office').length;
      const summaryParts = [];
      if (classCount) summaryParts.push(`${classCount} class${classCount === 1 ? '' : 'es'}`);
      if (counselCount) summaryParts.push(`${counselCount} counseling`);
      if (officeCount) summaryParts.push('office hours');
      if (!summaryParts.length) summaryParts.push('Fully free');

      const summary = document.createElement('span');
      summary.className = 'day-summary';
      summary.textContent = summaryParts.join(' · ');
      heading.appendChild(summary);

      block.appendChild(heading);

      block.appendChild(buildDayTimeline(day, slots, now));

      frag.appendChild(block);
    });

    el.scheduleList.innerHTML = '';
    el.scheduleList.appendChild(frag);

    // The segment labels depend on the rendered width, so they can only be
    // trimmed once the schedule is in the document and has been laid out.
    trimSegmentLabels();
  }

  function renderSlots() {
    const now = nowInTimezone(state.timezone);
    const days = weekOrder(Object.keys(state.schedule), now.day);
    const slots = [];

    days.forEach(day => {
      Object.entries(state.schedule[day]).forEach(([slotKey, entry]) => {
        if (!entry || entry.type !== 'counseling') return;

        const startMinutes = toMinutes(entry.start_time);
        const isPast = day === now.day && startMinutes <= now.minutesOfDay;
        if (isPast) return;

        slots.push({ day, slotKey, entry });
      });
    });

    el.slotList.innerHTML = '';

    if (slots.length === 0) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No upcoming counseling slots are open right now.';
      el.slotList.appendChild(note);
      el.bookingForm.hidden = true;
      return;
    }

    slots.forEach(slot => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.day = slot.day;
      btn.dataset.slotKey = slot.slotKey;

      const left = document.createElement('div');
      left.className = 'slot-left';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.innerHTML = '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>';

      const time = document.createElement('span');
      time.className = 'slot-time';
      time.textContent = `${slot.day} · ${formatTime12(slot.entry.start_time)}`;

      const location = document.createElement('span');
      location.className = 'slot-location';
      location.textContent = slot.entry.location || '';

      left.appendChild(icon);
      left.appendChild(time);
      if (location.textContent) left.appendChild(location);

      const tag = document.createElement('span');
      tag.className = 'slot-tag';
      tag.textContent = 'Available';

      btn.appendChild(left);
      btn.appendChild(tag);

      btn.addEventListener('click', () => selectSlot(slot, btn));

      el.slotList.appendChild(btn);
    });
  }

  function selectSlot(slot, btn) {
    // Clear previous selection.
    el.slotList.querySelectorAll('.slot').forEach(s => s.setAttribute('aria-checked', 'false'));

    btn.setAttribute('aria-checked', 'true');
    state.selectedSlot = slot;

    el.bookingSummaryText.textContent =
      `${slot.day} · ${formatTime12(slot.entry.start_time)} – ${formatTime12(slot.entry.end_time)}` +
      (slot.entry.location ? ` · ${slot.entry.location}` : '');

    el.bookingForm.hidden = false;
    el.formNote.textContent = '';
    el.bookingForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Booking submit ---
  function handleSubmit(e) {
    e.preventDefault();

    if (!state.selectedSlot) {
      el.formNote.textContent = 'Please select a slot first.';
      return;
    }

    // The form carries `novalidate` so we can show a single, clear message
    // instead of the browser's native bubble.
    const name = el.studentName.value.trim();

    if (!name) {
      el.formNote.textContent = 'Please enter your name.';
      el.studentName.focus();
      return;
    }

    const slot = state.selectedSlot;
    const payload = {
      name: el.studentName.value.trim(),
      studentId: el.studentId.value.trim(),
      topic: el.studentTopic.value.trim(),
      day: slot.day,
      slot: slot.slotKey,
      startTime: slot.entry.start_time,
      endTime: slot.entry.end_time,
      location: slot.entry.location || '',
      timezone: state.timezone
    };

    const mailto = buildMailto(payload);

    el.formNote.textContent = 'Request prepared. Send it from your email client to confirm.';
    showToast('Appointment request prepared');
    window.location.href = mailto;

    el.bookingForm.reset();
    state.selectedSlot = null;
    el.slotList.querySelectorAll('.slot').forEach(s => s.setAttribute('aria-checked', 'false'));
    el.bookingSummaryText.textContent = 'Select a slot to continue.';
    renderSlots();
  }

  /**
   * Build the mailto: URL for an appointment request.
   *
   * There is no backend on this static site, so the request is handed to the
   * user's own email client. Everything stays on the device. The request is
   * addressed to the lecturer; the sender's own address is filled in by
   * their mail app.
   */
  function buildMailto(payload) {
    const when = `${payload.day}, ${formatTime12(payload.startTime)} – ${formatTime12(payload.endTime)}`;

    const summary =
      `Appointment request\n` +
      `Name: ${payload.name}\n` +
      (payload.studentId ? `Student ID: ${payload.studentId}\n` : '') +
      (payload.topic ? `Topic: ${payload.topic}\n` : '') +
      `Slot: ${when}\n` +
      (payload.location ? `Location: ${payload.location}\n` : '') +
      `Timezone: ${payload.timezone}`;

    return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Counseling Appointment Request')}&body=${encodeURIComponent(summary)}`;
  }

  // --- Toast ---
  let toastTimeout = null;
  function showToast(message) {
    if (!el.toast || !el.toastMsg) return;
    el.toastMsg.textContent = message;
    el.toast.classList.add('show');

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      el.toast.classList.remove('show');
    }, 2800);
  }

  // --- Init ---
  function init() {
    initTheme();
    el.themeBtn.addEventListener('click', toggleTheme);
    el.bookingForm.addEventListener('submit', handleSubmit);
    loadSchedule();

    // Segment labels are trimmed to fit, so they have to be re-checked
    // whenever the page width changes.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(trimSegmentLabels, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposed so the mailto: URL can be inspected without triggering a
  // navigation to the user's mail client.
  window.trackMe = { buildMailto, nowInTimezone, formatTime12, toMinutes };
})();
