# doctor-approval-off

A scenario repository of the Kanon e2e harness: a fresh install of Kanon's `review` feature
at Kanon `{{release}}`, in `{{repository}}`, with one thing broken on purpose (Kanon plan 0012
step E12). The harness writes `ended` in the adoption record but never requires the approving review, and checks that doctor reports `ruleset.approval-off`, then deletes it.
