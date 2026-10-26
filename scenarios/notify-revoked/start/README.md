# notify-revoked

A scenario repository of the Kanon e2e harness: a dead chat webhook (harness #123, Kanon plan
0011 step N12), at Kanon `{{release}}`, in `{{repository}}`. The harness installed Kanon's review
lane and daily project digest here with Kanon's Slack hook, stored a Slack webhook URL that no
workspace holds as `KANON_CHAT_PROJECT_DIGEST`, had the test Author dispatch the digest, checked
that its `notify` job failed while its `digest` job succeeded and that `kanon doctor` reports
`notify.failing`, and deletes the repository.
