# refuse-deploy-ci-red

A scenario repository of the Kanon e2e harness: a gate refusal (Kanon plan 0012 step E12), at
Kanon `{{release}}`, in `{{repository}}`. The harness installed Kanon's deploy lane here, merged a
change that turns the project's own CI red, cut a release from it, checked that the deploy lane's
gate refused it, and deletes the repository. Nothing here deploys anywhere: the hooks under
`.github/actions/` build one file, check it arrived, and touch no cloud.
