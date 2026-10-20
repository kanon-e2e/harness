# lane-check-mixed-pin

A scenario repository of the Kanon e2e harness (Kanon plan 0012 step E12, the `lane-check`
family): a fresh install of Kanon's `review` feature at Kanon `{{release}}`, in `{{repository}}`.
The harness installed Kanon here as an adopter does, then opened one pull request that breaks
the `apps-check` caller with a second, older exact pin, which `Lane check` must fail, and one that keeps it
correct, which `Lane check` must pass. It deletes the repository when it is done.
