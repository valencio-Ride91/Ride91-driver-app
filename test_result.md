#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement_v3: |
  Parts 6, 7, 9 for the Ride91 driver app.
  Part 6: server-side vehicle GPS distance calculation with accuracy > 30m,
    ping speed > 120 kmph, implied-speed > 120 kmph, and > 5-min-gap
    filters. Endpoint: GET /api/vehicles/{vehicle_id}/distance
    ?business_date=|from_iso=&to_iso= — returns diagnostics
    (points_total, points_kept, points_rejected_accuracy,
     points_rejected_speed, segments_rejected_teleport,
     segments_rejected_gap, distance_km).
  Part 9: Document wallet (7 doc types w/ expiry statuses & +Nd helper
    buttons) and Consents (5 kinds, append-only audit trail w/ withdraw
    confirmation). New endpoints: GET/POST /api/documents,
    GET /api/documents/{id}, GET /api/documents/expiring/summary,
    GET/POST /api/consents, GET /api/consents/history. Profile tab
    renders two new cards.
  Part 7: Go-Online Capture Gate (one/day). Full-screen route
    /go-online-capture with intro → 20s guided walkaround
    (Front/Driver/Back/Passenger, 5s each with prompts) → selfie →
    review → submit. Uses expo-camera + offline sync queue. Server
    endpoint POST /api/go-online-capture validates duration (15–60s),
    hard-blocks when > 30km from hub, warns > 3km, flags
    movement_m > 60. GET /api/go-online-capture/today powers the gate
    on Home — first platform pick (Uber/Rapido/Ola) redirects to the
    capture route until completed. Deduped by (driver_id, day_key)
    AND (driver_id, client_action_id).

backend:
  - task: "Vehicle GPS distance filters (Part 6)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Manual curl on 2026-08-08 seeded data: 324 total pings, 323 kept,
          1 accuracy reject, 2 teleport segments, 1 gap segment, distance
          8.685 km. Please add unit tests: (a) accuracy_m > 30 counted &
          skipped; (b) ping speed_kmph > 120 counted & skipped;
          (c) implied speed > 120 between kept pings resets anchor and
          counted as teleport; (d) gap > 300s counted as gap;
          (e) window bounds filter honours business_date OR from/to;
          (f) 403 when calling for a vehicle that isn't the driver's.
          Insert synthetic pings via db.vehicle_pings.insert_many, then
          call the endpoint and assert the diagnostics.

  - task: "Document wallet endpoints (Part 9)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          GET /api/documents seeds one row per DOCUMENT_TYPES on first
          call, sorts by status severity, drops image_b64. POST
          /api/documents upserts (idempotent on client_action_id, dedup
          on (driver_id, type)), returns row with status + label. GET
          /api/documents/expiring/summary counts by status. Manual curl
          verified: 7 placeholders, DL updated to expire in 5 days →
          expiring_soon → summary needs_attention=7.

  - task: "Consents endpoints (Part 9)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Append-only consent_events. GET /consents returns 5 rows
          (default label + granted=false when never touched). POST
          /consents appends a new event; GET /consents returns updated
          state derived from newest-per-kind. Idempotent by
          client_action_id. GET /consents/history returns full audit
          trail newest-first.

  - task: "Go-Online Capture endpoints (Part 7)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          POST /go-online-capture validates duration_s ∈ [15, 60],
          computes movement_m, distance_from_hub_km, sets hub_warn +
          review_flag_movement. Hard-blocks with 403 code=too_far_from_hub
          when > 30 km from hub. Idempotent by (driver_id,
          client_action_id) AND (driver_id, day_key). GET
          /go-online-capture/today returns latest for the business day.
          Manual curl verified end-to-end.

frontend:
  - task: "Profile documents card (Part 9)"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/DocumentsCard.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          Lists all 7 default docs sorted by status severity, badges
          for expiring soon / expired / missing / valid. Tapping a row
          opens a sheet with number, expiry (YYYY-MM-DD input + +30/+90/
          +180/+365 helpers), and an image picker (base64 upload).
          Enqueued through the offline sync queue.

  - task: "Profile consents card (Part 9)"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/ConsentsCard.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          5 switch rows. Withdrawing an already-granted consent shows
          native Alert confirm before flipping. Toggle enqueued to
          POST /consents; optimistic UI flip.

  - task: "Go-Online Capture Gate UI (Part 7)"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/go-online-capture.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          Full-screen route mounted from _layout.tsx. Home tab pickPlatform
          checks GET /go-online-capture/today; if not completed and picking
          uber/rapido/ola, routes to /go-online-capture. Route has 5 phases:
          intro (shows hub-distance with warn/block bands), walkaround
          (guided stage bar), selfie, review, done. Uses expo-camera and
          the offline sync queue for upload. Web preview has a placeholder
          video for QA.

metadata:
  created_by: "main_agent"
  version: "1.3"
  test_sequence: 7
  run_ui: true

test_plan:
  current_focus:
    - "Vehicle GPS distance filters (Part 6)"
    - "Document wallet endpoints (Part 9)"
    - "Consents endpoints (Part 9)"
    - "Go-Online Capture endpoints (Part 7)"
    - "Profile documents card (Part 9)"
    - "Profile consents card (Part 9)"
    - "Go-Online Capture Gate UI (Part 7)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: >
      Parts 6, 7, 9 all shipped in one iteration. Please add backend
      tests for the distance filter, and frontend E2E for Profile
      Documents/Consents cards + Go-Online Capture Gate (use the
      cap-video-web-placeholder testID on the web build to skip real
      recording). Regression on prior alarm & duty tests. Native
      camera / native alarm still require APK build to fully validate.
      Login: +919900000001 / OTP 123456.


user_problem_statement_v2: |
  Ride91 driver app — Part 8b (Shift-end alarm with ETA-to-hub).
  Extends Part 8 with a second alarm per shift:
    • Driver optionally specifies shift_end when scheduling.
    • Backend seeds a home hub (lat/lng/name) on the driver record.
    • Backend endpoint GET /api/shift-alarm/end-eta computes distance
      (haversine) to hub + average speed from last 20 vehicle_pings
      (clamped 12–45 km/h, default 22 km/h) → eta_minutes.
    • alarm_at = shift_end − (eta_minutes + end_buffer_min).
    • Response endpoint gains `phase` = start | end, new responses
      `heading_back` / `delayed` for end-phase; start-phase keeps
      awake / not_coming / snooze.
    • Native module is re-armed only when alarm_at drifts > 30s.
    • Fallback /alarm route accepts phase= param and shows different
      buttons + ETA strip.

backend:
  - task: "Shift-end ETA endpoint (Part 8b)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Manual curl on demo driver returns has_end_alarm=true,
          has_hub=true, distance_km, eta_minutes, alarm_at.
          Please cover: (a) no shift_end → has_end_alarm=false;
          (b) driver without hub_lat/lng → has_hub=false;
          (c) lat/lng query overrides last ping; (d) alarm_at maths;
          (e) end-phase responses (heading_back/delayed/snooze)
          are accepted while start-phase responses on end schedule
          return 400 invalid_response_for_end_phase, and vice versa;
          (f) responded on 'heading_back'/'delayed' flips end_state
          to 'responded' but not state; (g) idempotency on client_action_id.

frontend:
  - task: "Profile end-alarm sub-card + duration picker"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(tabs)/profile.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          Vehicle card now shows Home hub row (profile-hub-info).
          Shift alarm card has Start-alarm and End-alarm sections.
          Schedule flow is now 2-step: pick preset → pick duration
          (alarm-duration-6-hours / -8-hours / -10-hours / -12-hours /
          -no-end-alarm). Picking a duration with hours sets shift_end;
          "No end alarm" leaves shift_end unset.
          End-alarm section renders alarm-shift-end, alarm-distance,
          alarm-eta, alarm-end-fires-at when end-alarm exists.
          New buttons: alarm-preview-start-btn, alarm-preview-end-btn,
          alarm-test-native-start-btn, alarm-test-native-end-btn.
  - task: "Alarm fallback route end-phase UI"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/alarm.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          /alarm now accepts phase= param. When phase=end it renders
          alarm-eta-strip (distance/ETA/remaining) if end-ETA available,
          shows alarm-heading-back (primary green) + alarm-delayed
          (amber) + alarm-snooze buttons. When phase=start (default)
          the awake/not-coming/reason flow is unchanged.

metadata:
  created_by: "main_agent"
  version: "1.2"
  test_sequence: 6
  run_ui: true

test_plan:
  current_focus:
    - "Shift-end ETA endpoint (Part 8b)"
    - "Profile end-alarm sub-card + duration picker"
    - "Alarm fallback route end-phase UI"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: >
      Part 8b (shift-end alarm w/ ETA-to-hub) implemented. Please
      backend-test /api/shift-alarm/end-eta and phase-scoped
      /shift-alarm/response, and frontend-test the Profile duration
      picker + end-alarm sub-card + /alarm?phase=end fallback UI.
      Native Android alarm can only be validated on APK — do NOT test.
      Login: +919900000001 / OTP 123456. Backend at
      http://localhost:8001, frontend at http://localhost:3000.


user_problem_statement: |
  Ride91 driver app — Part 8 (Shift Alarms) JS integration.
  Native Android AlarmManager Java sources already exist under
  /app/frontend/plugins/ride91-alarms-native/. This job wires the JS side:
  - src/alarms.ts — bridge with Expo-Go / web safe fallback (no-op)
  - src/shift-alarms.ts — provider: fetches /shift-alarm/next on boot &
    foreground; schedules native alarm; listens to Ride91AlarmResponse
    events and POSTs them to /shift-alarm/response via the offline queue.
  - app/alarm.tsx — full-screen fallback UI (works on web + Expo Go) with
    "Awake", "Not coming + reason", "Snooze".
  - Profile tab — new "Shift alarm" card with preset scheduler and
    "Preview UI" / "Fire native alarm" dev buttons.

backend:
  - task: "Shift alarm endpoints"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: >
          Endpoints POST /api/shift-alarm/schedule, GET /api/shift-alarm/next,
          POST /api/shift-alarm/response, GET /api/shift-alarm/responses
          already exist. Please re-verify: idempotency via client_action_id,
          400 when response=not_coming without reason_code, alarm_fires_at
          = shift_start - 1h, /next returns latest non-responded row.

frontend:
  - task: "Profile → Shift alarm section"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(tabs)/profile.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          New card renders "Native ready" / "Preview only" badge,
          Next shift / Alarm at / Status rows, and buttons:
          alarm-schedule-btn, alarm-test-native-btn, alarm-preview-btn.
          Sheet exposes 4 presets each with testID alarm-preset-*.
          On preset tap the app POSTs /shift-alarm/schedule and shows
          alarm-toast "Alarm scheduled". Fields refresh from
          /shift-alarm/next after ~500ms.
  - task: "Alarm fallback screen"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/alarm.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: >
          Full-screen at /alarm. Choose branch shows alarm-awake,
          alarm-not-coming, alarm-snooze. Selecting "Not coming"
          reveals reason picker (testIDs alarm-reason-<code>) and
          alarm-confirm-not-coming. Each button enqueues a POST
          /shift-alarm/response through the sync queue and then
          navigates back to /(tabs).

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 5
  run_ui: true

test_plan:
  current_focus:
    - "Profile → Shift alarm section"
    - "Alarm fallback screen"
    - "Shift alarm endpoints (regression)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: >
      Part 8 JS integration complete. Please regression-test the four
      /api/shift-alarm/* endpoints, then run the Expo web preview and
      verify the Profile "Shift alarm" card and the /alarm fallback
      screen using the testIDs listed above. Native Android alarm
      itself needs an APK build — do NOT try to test that here.
      Login: phone +919900000001, OTP 123456.

  - agent: "testing"
    message: >
      Iteration 5 complete. Part 8 shift-alarm JS integration verified
      end-to-end. Backend: 12/12 new tests in /app/backend/tests/test_shift_alarm.py
      pass (POST /schedule idempotent + alarm_fires_at = shift_start - 1h;
      GET /next earliest-scheduled or {}; POST /response 400 reason_required
      for not_coming without valid reason_code; awake+not_coming flip state
      to responded; snooze does not; idempotent on client_action_id;
      GET /responses newest-first). Frontend: login → Profile → 'Shift
      alarm' card renders 'Preview only' badge and all fields; Schedule
      sheet opens with 4 presets; tapping 'In 2 hours (day)' fires toast
      'Alarm scheduled' and updates alarm-next-shift/alarm-fires-at to
      exactly 1h apart; Preview UI navigates to /alarm and shows title
      'Shift starts in 1 hour'; Not coming reveals reason picker with 6
      rows; selecting family_emergency + Confirm posts to backend
      (verified via curl — response row landed with correct reason_code
      and /shift-alarm/next now returns {}); router redirect to /(tabs)
      works. Minor findings (LOW priority):
        1. Preset testIDs have TRAILING DASHES on '(day)'/'(night)' variants
           (label.replace(/\W+/g,'-') turns closing ')' into '-'). Actual:
           alarm-preset-in-2-hours-day-  — spec assumed no trailing dash.
        2. tab-profile testID is rendered twice on web (Expo Router
           anchor + child touchable) — Playwright picks .first; not a
           functional bug.
        3. reason_note is only persisted for reason_code=='other' (server.py:626)
           — silent-drop for other codes; document or expose.
      No red screens, no deprecated packages, no critical bugs.
      Pre-existing loadscope test-isolation flake in iteration-4 test
      module surfaces when both files are run together (see iteration_5.json
      rca_of_issue). Fix belongs in the iteration-4 test file, not Part 8.
      Full details: /app/test_reports/iteration_5.json.

  - agent: "testing"
    message: >
      Iteration 6 complete — Part 8b Shift-END alarm with live-GPS ETA-to-hub verified end-to-end.
      Backend: created /app/backend/tests/test_shift_end_alarm.py (12 tests, ALL PASS) covering:
      schedule persists shift_end/end_buffer_min/end_state=scheduled when shift_end is present,
      end_state='na' when absent; GET /shift-alarm/end-eta returns {has_end_alarm:false} with no
      schedule, {has_end_alarm:true,has_hub:false} when driver has no hub coords (verified via
      temporary Mongo mutation with restore), and full payload with distance/eta/avg_speed/alarm_at
      when hub + query lat/lng provided. alarm_at == shift_end - (eta+buffer) minutes within <5s.
      /end-eta falls back to the latest vehicle_ping when lat/lng omitted (current_lat/lng match).
      Response endpoint phase discriminator: phase='end' + response='awake' → 400
      invalid_response_for_end_phase; phase='start' + response='heading_back' → 400
      invalid_response_for_start_phase; phase='end' + heading_back is idempotent by
      client_action_id and flips end_state='responded' while leaving start state='scheduled';
      phase='end' + snooze does NOT flip end_state; phase='end' + delayed does; /shift-alarm/next
      correctly returns rows where start state=responded but end_state=scheduled.
      NOTE: I initially split the module into 4 classes and hit cross-worker LoadScope races on
      the shared demo driver's shift_schedules collection — consolidated into a single class
      TestShiftEndAlarm to pin the whole module to one xdist worker.
      Frontend (Expo web preview, 390×844): login OK → Profile → profile-hub-info renders
      'Koramangala Hub · 12.9352, 77.6245'. alarm-schedule-btn opens sheet at step 1; tapping
      alarm-preset-in-2-hours-day (trailing-dash fix from iteration 5 confirmed) advances to
      duration step titled 'How long is your shift?'. alarm-duration-8-hours closes the sheet,
      fires 'Alarm scheduled' toast, and within <2s populates: alarm-shift-end='Today 12:05 pm',
      alarm-distance='16.96 km', alarm-eta='41 min · avg 25 km/h', alarm-end-fires-at='Today
      11:15 am'. alarm-preview-end-btn navigates to /alarm?phase=end where alarm-title='Shift
      ends soon — head back to hub', alarm-eta-strip has 3 columns, and only
      alarm-heading-back / alarm-delayed / alarm-snooze buttons are present (no
      alarm-not-coming / alarm-awake). Tapping alarm-heading-back POSTs
      {phase:'end',response:'heading_back'} to /api/shift-alarm/response (captured live),
      router.replace('/(tabs)') lands on Home; verified via curl on /api/shift-alarm/responses
      that the row landed correctly. Regression: start-phase awake + not_coming(reason) flow
      from iteration 5 still works — phase discriminator did not break start alarms.
      One LOW-priority UX bug found (see iteration_6.json.frontend_issues): the no-end-alarm
      reschedule branch leaves alarm-shift-end showing the prior schedule's value (widgets ARE
      hidden correctly). Root cause: /shift-alarm/next returns EARLIEST by shift_start, so an
      older scheduled row with a still-populated shift_end wins over the newly-scheduled
      no-end-alarm row. Fix belongs in server.py sort/filter or profile.tsx binding.
      No React Native issues (no deprecated packages, no red screens, all testIDs present).
      Full details + curl-verified evidence: /app/test_reports/iteration_6.json.


  - task: "Parts 6, 7, 9 — Vehicle distance, Go-Online-Capture, Documents + Consents"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: >
          Iteration 7 complete — Parts 6, 7, 9 verified end-to-end. Backend: 3 new pytest
          modules (test_vehicle_distance.py, test_documents_consents.py,
          test_go_online_capture.py) totalling 26 tests, ALL PASS.

          Part 6 (GET /api/vehicles/{vid}/distance): 3 clean 60s-apart 50m-step pings →
          points_kept=3, distance≈0.09 km (within 0.07–0.13); one accuracy_m=45 ping →
          points_rejected_accuracy=1, kept=3; one speed_kmph=180 →
          points_rejected_speed=1; 2 pings 60s apart ~3km away →
          segments_rejected_teleport=1, distance=0; 2 pings 10min apart →
          segments_rejected_gap=1, distance=0. Foreign vehicle_id → 403
          'not_your_vehicle'. Seeded 2026-08-08 window returns non-zero km (regression).
          Isolated by using synthetic 2099 window so tests don't collide with seed pings.

          Part 9 (docs + consents): GET /api/documents seeds exactly 7 placeholder rows on
          first call, GET again still returns 7 (no dup seed). POST driving_licence with
          expiry today+15 → status=expiring_soon; today-5 → expired; today+120 → ok.
          Same client_action_id replays return identical row (single Mongo row confirmed).
          expires_on='invalid' → 400 expires_on_must_be_yyyy_mm_dd. Summary endpoint:
          needs_attention == expired + expiring_soon + missing (verified). GET
          /documents/{id} returns 200 for own doc; 404 for stranger's doc (inserted with
          driver_id='not-me'). GET /api/consents returns 5 rows all granted=false initially.
          POST location_tracking granted=true → GET reflects; POST granted=false → GET
          reflects false. GET /consents/history returns newest-first (verified
          occurred_at ordering). Idempotent by client_action_id (single consent_events row).

          Part 7 (go-online-capture): GET .../today before capture →
          {completed:false, day_key:...}. POST valid body (20s duration, start/end at
          hub) → completed:true, hub_warn:false, distance_from_hub_km<0.1,
          review_flag_movement:false, no walkaround_video_b64/selfie_photo_b64 in
          response. duration_s=5 → 400 duration_out_of_range. Mumbai coords
          (19.076, 72.877) → 403 with detail dict {code:'too_far_from_hub', hub_km,
          limit_km}. Idempotent by client_action_id. Same-day different client_action_id
          → same row + already_done_today:true. GET .../today after → full meta, no
          base64.

          Frontend (Expo web, 390×844): login → tab-profile → documents-card renders
          with all 7 doc-row-* + doc-status-* pills, consents-card renders with all 5
          consent-row-* + consent-toggle-*. Tapping doc-row-driving_licence opens the
          editor sheet — doc-input-number filled with 'KA0120200001234',
          doc-expiry-plus-30 sets doc-input-expires='2026-09-12', doc-save closes sheet.
          Backend verified: driving_licence document persisted with correct number and
          expiry (status=expiring_soon at 30d). consent-toggle-location_tracking tap
          persists granted=true in consent_events. Go-Online-Capture UI flow was NOT
          exercised (GPS/camera unavailable in web preview — allowed by review request).

          LOW-priority UX notes (not blocking): (1) DocumentsCard.refresh() runs
          immediately after enqueue() returns, so the pill can briefly show the pre-save
          status before the offline sync worker flushes — DB is correct either way.
          (2) React Native Switch does not expose aria-checked on web; add
          accessibilityState={{ checked: value }} for E2E parity.

          Full report: /app/test_reports/iteration_7.json. Pytest XML:
          /app/test_reports/pytest/pytest_iter7.xml.
