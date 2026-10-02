import json, urllib.request, urllib.error
BASE = "https://ride91-api-561130004577.asia-south1.run.app/api"
def call(m, p, tok=None, body=None):
    req = urllib.request.Request(BASE+p, data=json.dumps(body).encode() if body is not None else None, method=m)
    req.add_header("Content-Type", "application/json")
    if tok: req.add_header("Authorization", "Bearer "+tok)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read().decode() or "null")
def line(*a): print(*a, flush=True)

st, r = call("POST", "/admin/login", body={"username": "ride91ops", "password": "Ride91!"})
assert st == 200, ("login failed", st, r); tok = r["token"]
line("1. owner login OK")

# --- Settings now carries the reward knobs ---
st, s = call("GET", "/admin/settings", tok)
need = ["reward_daily_target","reward_week_driver_target","reward_days_required",
        "loyalty_milestones","yearly_top_driver","yearly_top_car"]
missing = [k for k in need if k not in s]
line("2. settings reward keys present:", "ALL" if not missing else ("MISSING %s" % missing))
assert not missing, s
line("   weekly driver target=%s, yearly top driver=%s, milestones=%d" % (
    s["reward_daily_target"], s["yearly_top_driver"], len(s["loyalty_milestones"])))

# --- Change a threshold, confirm it reflects, then restore ---
orig = s["reward_daily_target"]
st, r = call("PUT", "/admin/settings", tok, {"reward_daily_target": orig + 111})
assert st == 200, ("put failed", st, r)
st, rw = call("GET", "/admin/rewards", tok)
got = rw["thresholds"]["daily_target"]
line("3. threshold change reflected in /admin/rewards: %s -> %s %s" % (orig, got, "OK" if got == orig+111 else "FAIL"))
assert got == orig + 111, rw
call("PUT", "/admin/settings", tok, {"reward_daily_target": orig})   # restore
line("   restored to %s" % orig)

# --- Loyalty endpoint ---
st, l = call("GET", "/admin/loyalty", tok)
assert st == 200, ("loyalty failed", st, l)
line("4. /admin/loyalty OK — year=%s, hubs=%d, milestones=%d, thresholds=%s" % (
    l["year"], len(l["hubs"]), len(l["milestones"]), l["thresholds"]))

# --- Collections report (empty until Razorpay live, but endpoint must work) ---
st, c = call("GET", "/admin/collections", tok)
assert st == 200, ("collections failed", st, c)
line("5. /admin/collections OK — grand_total=%s, drivers=%d" % (c["grand_total"], len(c["items"])))

# --- Collection QR create: expect 503 until Razorpay keys are set ---
st, d = call("GET", "/admin/drivers", tok)
drv = d["items"][0] if d.get("items") else None
if drv:
    st, q = call("POST", "/admin/drivers/%s/collection-qr" % drv["id"], tok)
    if st == 503 and isinstance(q, dict) and q.get("detail") == "razorpay_not_configured":
        line("6. collection-QR create -> 503 razorpay_not_configured (expected; set keys to enable)")
    elif st == 200:
        line("6. collection-QR create -> 200 LIVE! qr_code_id=%s image=%s" % (q.get("qr_code_id"), bool(q.get("image_url"))))
    else:
        line("6. collection-QR create -> %s %s" % (st, q))
line("\nLIVE VERIFICATION DONE")
