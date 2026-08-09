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
