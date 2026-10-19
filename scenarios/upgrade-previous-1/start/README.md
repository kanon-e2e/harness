# upgrade-previous-1

A scenario repository of the Kanon e2e harness: Kanon's `full` feature installed at
the stable release before the latest one below `{{release}}` (`previous-1`), then upgraded to Kanon `{{release}}`
(Kanon plan 0012 step E7), in `{{repository}}`. The harness made it, installed the older
release here as an adopter does, upgraded it through a pull request, checked that doctor finds
it healthy, and deletes it.
