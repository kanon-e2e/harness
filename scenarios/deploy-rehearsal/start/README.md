# deploy-rehearsal

A scenario repository of the Kanon e2e harness: the deploy lane's rehearsal (Kanon plan 0012
step E5), at Kanon `{{release}}`, in `{{repository}}`. The harness made it, runs three releases
through Kanon's deploy lane here, and deletes it. Nothing here deploys anywhere: the hooks under
`.github/actions/` build one file, check it arrived, and touch no cloud.
