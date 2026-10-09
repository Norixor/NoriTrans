import type { NetflixTimedTextCandidate } from "@/src/subtitles/adapters/netflix-manifest";
import {
  NetflixTitleGate,
  netflixWatchTitleId,
} from "@/src/subtitles/adapters/netflix-title-gate";
import { describe, expect, it } from "vitest";

function candidate(name: string, titleId?: string): NetflixTimedTextCandidate {
  return {
    url: `https://ipv4-c001.nflxvideo.net/?o=${name}`,
    language: "en",
    profile: "imsc1.1",
    trackKey: name,
    ...(titleId === undefined ? {} : { titleId }),
  };
}

const urls = (values: readonly NetflixTimedTextCandidate[]): string[] =>
  values.map((value) => value.url);

describe("Netflix title gate", () => {
  it("reads the numeric watch id from the path only", () => {
    expect(netflixWatchTitleId("/watch/81234567")).toBe("81234567");
    expect(netflixWatchTitleId("/watch/81234567/extra")).toBe("81234567");
    expect(netflixWatchTitleId("/watch/abc")).toBeUndefined();
    expect(netflixWatchTitleId("/browse")).toBeUndefined();
  });

  it("keeps every candidate current until a manifest matches the watch id", () => {
    const gate = new NetflixTitleGate("/watch/111");
    const admission = gate.remember([candidate("next", "222")]);

    expect(gate.isLearned).toBe(false);
    expect(admission).toEqual({ stored: 1, foreign: 0 });
    expect(urls(gate.current())).toEqual([candidate("next").url]);
    expect(
      gate.foreignTitleIdFor(candidate("next").url, "/watch/111"),
    ).toBeUndefined();
  });

  it("holds other titles once the watched title's manifest was seen", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("one", "111")]);
    const admission = gate.remember([candidate("two", "222")]);

    expect(gate.isLearned).toBe(true);
    expect(admission).toEqual({
      stored: 1,
      foreign: 1,
      foreignTitleId: "222",
    });
    expect(urls(gate.current())).toEqual([candidate("one").url]);
    expect(gate.foreignTitleIdFor(candidate("two").url, "/watch/111")).toBe(
      "222",
    );
    expect(
      gate.foreignTitleIdFor(candidate("one").url, "/watch/111"),
    ).toBeUndefined();
    // Judged against the page showing, even before the gate rolls.
    expect(
      gate.foreignTitleIdFor(candidate("two").url, "/watch/222"),
    ).toBeUndefined();
  });

  it("learns from a manifest that also declares other titles", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("two", "222"), candidate("one", "111")]);

    expect(urls(gate.current())).toEqual([candidate("one").url]);
  });

  it("never filters candidates without a title id", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("one", "111"), candidate("plain")]);

    expect(urls(gate.current())).toEqual([
      candidate("one").url,
      candidate("plain").url,
    ]);
    expect(
      gate.foreignTitleIdFor(candidate("plain").url, "/watch/111"),
    ).toBeUndefined();
    expect(
      gate.foreignTitleIdFor("https://unknown.example/", "/watch/111"),
    ).toBeUndefined();
  });

  it("does not learn without a numeric watch id", () => {
    const gate = new NetflixTitleGate("/browse");
    gate.remember([candidate("one", "111"), candidate("two", "222")]);

    expect(gate.isLearned).toBe(false);
    expect(gate.current()).toHaveLength(2);
  });

  it("adopts held candidates of the next watch page and drops the rest", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("one", "111"), candidate("plain")]);
    gate.remember([candidate("two", "222"), candidate("three", "333")]);

    const roll = gate.roll("/watch/222");

    expect(urls(roll.adopted)).toEqual([candidate("two").url]);
    expect(roll.dropped).toBe(3);
    expect(urls(gate.current())).toEqual([candidate("two").url]);
    // Adopted candidates are matching evidence for the new page.
    expect(gate.isLearned).toBe(true);
    gate.remember([candidate("four", "444")]);
    expect(urls(gate.current())).toEqual([candidate("two").url]);
  });

  it("relearns after a roll without adopted candidates", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("one", "111")]);

    expect(gate.roll("/watch/222")).toEqual({ adopted: [], dropped: 1 });
    expect(gate.isLearned).toBe(false);
    gate.remember([candidate("three", "333")]);
    expect(urls(gate.current())).toEqual([candidate("three").url]);
    gate.remember([candidate("two", "222")]);
    expect(gate.isLearned).toBe(true);
    expect(urls(gate.current())).toEqual([candidate("two").url]);
  });

  it("drops everything when leaving watch pages", () => {
    const gate = new NetflixTitleGate("/watch/111");
    gate.remember([candidate("one", "111"), candidate("two", "222")]);

    expect(gate.roll("/browse")).toEqual({ adopted: [], dropped: 2 });
    expect(gate.current()).toEqual([]);
  });

  it("bounds remembered candidates by evicting the oldest parse", () => {
    const gate = new NetflixTitleGate("/browse");
    for (let index = 0; index < 120; index += 1)
      gate.remember([candidate(`c${index}`)]);

    const current = gate.current();
    expect(current).toHaveLength(96);
    expect(current[0]?.trackKey).toBe("c24");
  });
});
