import type { Briefing } from "@alden/schema";
import { useCallback, useRef, useState } from "react";
import type { Api, ReviewEvent, ReviewRequest } from "./api";

export interface ReviewRun {
  /** Stages seen so far, in order; the last is the current one while running. */
  stages: { stage: string; label: string }[];
  running: boolean;
  startedAt: number;
  error?: string;
  briefing?: Briefing;
  request: ReviewRequest;
}

/**
 * Reviews by key ("owner/repo#123", or "local"), kept for the session: a review keeps running while you look at
 * another PR, and its briefing is there when you come back.
 */
export function useReviews(api: Api | undefined) {
  const [runs, setRuns] = useState<Record<string, ReviewRun>>({});
  const controllers = useRef(new Map<string, AbortController>());

  const update = useCallback((key: string, change: (run: ReviewRun) => ReviewRun) => {
    setRuns((all) => {
      const run = all[key];
      return run ? { ...all, [key]: change(run) } : all;
    });
  }, []);

  const start = useCallback(
    (key: string, request: ReviewRequest) => {
      if (!api) return;
      controllers.current.get(key)?.abort();
      const controller = new AbortController();
      controllers.current.set(key, controller);
      setRuns((all) => ({ ...all, [key]: { stages: [], running: true, startedAt: Date.now(), request } }));
      const onEvent = (event: ReviewEvent) => {
        if (event.type === "stage") {
          update(key, (run) => ({ ...run, stages: [...run.stages, { stage: event.stage, label: event.label }] }));
        }
      };
      api
        .review(request, onEvent, controller.signal)
        .then((briefing) => update(key, (run) => ({ ...run, running: false, briefing })))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          update(key, (run) => ({ ...run, running: false, error: (error as Error).message }));
        })
        .finally(() => {
          if (controllers.current.get(key) === controller) controllers.current.delete(key);
        });
    },
    [api, update],
  );

  const cancel = useCallback(
    (key: string) => {
      controllers.current.get(key)?.abort();
      controllers.current.delete(key);
      update(key, (run) => ({ ...run, running: false, error: "Stopped." }));
    },
    [update],
  );

  return { runs, start, cancel };
}
