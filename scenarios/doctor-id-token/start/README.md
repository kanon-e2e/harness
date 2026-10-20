# doctor-id-token

A scenario repository of the Kanon e2e harness: a fresh install of Kanon's `review` feature
at Kanon `{{release}}`, in `{{repository}}`, with one thing broken on purpose (Kanon plan 0012
step E12). The harness adds a workflow whose job holds `id-token: write` and that the adoption record doesn't accept, and checks that doctor reports `id-token.unaccepted`, then deletes it.
