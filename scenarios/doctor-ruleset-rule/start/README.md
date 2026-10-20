# doctor-ruleset-rule

A scenario repository of the Kanon e2e harness: a fresh install of Kanon's `review` feature
at Kanon `{{release}}`, in `{{repository}}`, with one thing broken on purpose (Kanon plan 0012
step E12). The harness leaves out the ruleset's required `Lane check` rule, the last setting `init` names (`ruleset.require-check`), and checks that doctor reports `ruleset.rule-missing`, then deletes it.
