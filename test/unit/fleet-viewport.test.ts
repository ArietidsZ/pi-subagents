import assert from "node:assert/strict";
import { it } from "node:test";
import { FleetViewport } from "../../src/tui/fleet-viewport.ts";
import { fleetContains, fleetLayout } from "../../src/tui/fleet-layout.ts";

it("uses native clamping, line/page movement, and follow-end across growth and resize", () => {
	let requests = 0;
	const viewport = new FleetViewport(() => requests++);
	const lines = Array.from({ length: 100 }, (_, i) => String(i));
	assert.deepEqual(viewport.render(lines, 60, 10), lines.slice(90));
	viewport.scroll.scrollBy(-1);
	assert.equal(viewport.scroll.scrollTop, 89);
	assert.equal(viewport.scroll.isFollowingEnd, false);
	viewport.render([...lines, "100"], 60, 10);
	assert.equal(viewport.scroll.scrollTop, 89);
	viewport.scroll.scrollBy(-viewport.scroll.viewportHeight);
	assert.equal(viewport.scroll.scrollTop, 79);
	viewport.scroll.scrollBy(-10000);
	assert.equal(viewport.scroll.scrollTop, 0);
	const before = requests;
	viewport.scroll.scrollBy(-10000);
	assert.equal(requests, before, "clamped movement must not request redundant renders");
	viewport.scroll.scrollBy(10000);
	assert.equal(viewport.scroll.isFollowingEnd, true);
	assert.deepEqual(viewport.render([...lines, "100"], 30, 20), [...lines, "100"].slice(81));
	assert.deepEqual(viewport.render(lines.slice(0, 3), 30, 20), ["0", "1", "2"]);
	assert.equal(viewport.scroll.scrollTop, 0);
	assert.deepEqual(viewport.render([], 30, 2), []);
});

it("keeps intentional top resets paused even when content initially fits", () => {
	const viewport = new FleetViewport(() => {});
	viewport.render(Array(100).fill("normal output"), 80, 10);
	viewport.resetTop();
	assert.equal(viewport.scroll.isFollowingEnd, false);
	viewport.render(["short"], 80, 10);
	assert.equal(viewport.scroll.isFollowingEnd, false);
	viewport.render(Array(100).fill("wrapped"), 20, 10);
	assert.equal(viewport.scroll.scrollTop, 0);
	viewport.follow();
	assert.equal(viewport.scroll.scrollTop, 90);
	viewport.scroll.scrollBy(-5);
	viewport.render(Array(30).fill("collapsed"), 80, 10);
	assert.equal(viewport.scroll.scrollTop, 20);
	assert.equal(viewport.scroll.isFollowingEnd, true, "clamping back to the bottom resumes follow");
});

it("maps only visible stable roster keys and excludes borders and blank rows", () => {
	const items = Array.from({ length: 50 }, (_, i) => ({ key: `key-${i}` }));
	const layout = fleetLayout(100, 32, 49, items)!;
	assert.equal(layout.rosterKeys.at(-1), "key-49");
	assert.equal(layout.rosterKeys.length, layout.bodyHeight);
	assert.equal(fleetContains(layout.roster, 0, 3), false);
	assert.equal(fleetContains(layout.roster, layout.output.x - 1, 3), false);
	assert.equal(fleetContains(layout.output, layout.output.x, 3), true);
	assert.equal(fleetContains(layout.output, 99, 3), false);
	assert.equal(fleetLayout(35, 32, 0, items), undefined);
	assert.deepEqual(fleetLayout(60, 12, 0, [{ key: "one" }])!.rosterKeys, ["one"]);
});
