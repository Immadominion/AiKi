import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /*
     * Database tests run one file at a time.
     *
     * They share one database, and one of them truncates. `TRUNCATE jobs,
     * authorizations CASCADE` reaches every table with a foreign key into
     * those, which now includes tasks and approvals, so run in parallel it
     * deletes rows another file is midway through asserting on. That surfaced
     * as a task vanishing between being claimed and being read back: a failure
     * that looks exactly like a concurrency bug in the code under test and is
     * not one.
     *
     * The suite guards money and has already produced two false passes in its
     * life. Determinism is worth more than the seconds this costs.
     */
    fileParallelism: false,
  },
})
