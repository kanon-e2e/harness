// What a scenario's `fail` is (Kanon plan 0012 §5.1, §10): an expectation that was false, or a
// deadline that passed. A verb throws `Fail` for those and nothing else; any other error is the
// runner's to classify (E4), and a `Fail` is never retried: it is the finding.

export class Fail extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'Fail';
  }
}
