import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FluentBundle, FluentResource } from "@fluent/bundle";

/** Simulate the host formatter using real Fluent syntax/formatting in Node. */
export function mockLocalization(locale = "en-US") {
  return class Localization {
    constructor(resourceIDs, sync) {
      assert.deepEqual(Array.from(resourceIDs), ["knowledgemcp.ftl"]);
      assert.equal(sync, true);
      this.bundle = new FluentBundle(locale, { useIsolating: false });
      const source = readFileSync(`addon/locale/${locale}/knowledgemcp.ftl`, "utf8");
      assert.deepEqual(this.bundle.addResource(new FluentResource(source)), []);
    }

    formatValueSync(id, args) {
      return this.formatMessagesSync([{ id, args }])[0]?.value ?? null;
    }

    formatMessagesSync(messages) {
      return Array.from(messages, ({ id, args }) => {
        const message = this.bundle.getMessage(id);
        if (!message) return null;
        const errors = [];
        const format = pattern => this.bundle.formatPattern(pattern, args, errors);
        const value = message.value ? format(message.value) : null;
        const attributes = Object.entries(message.attributes).map(([name, pattern]) => ({ name, value: format(pattern) }));
        assert.deepEqual(errors, [], id);
        return { value, attributes: attributes.length ? attributes : null };
      });
    }
  };
}
