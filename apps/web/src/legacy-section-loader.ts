export interface LegacySectionLoaderRequest<TSection extends string> {
  readonly campaignId: string;
  readonly selectionEpoch: number;
  readonly section: TSection;
  readonly signal: AbortSignal;
}

export interface LegacySectionLoader<TSection extends string, TValue> {
  setSelection(campaignId: string, selectionEpoch: number): void;
  loadSection(section: TSection, signal?: AbortSignal): Promise<TValue>;
  invalidate(section: TSection): void;
}

export interface CreateLegacySectionLoaderOptions<TSection extends string, TValue> {
  loadSection(request: LegacySectionLoaderRequest<TSection>): Promise<TValue>;
}

interface SelectionScope {
  readonly campaignId: string;
  readonly selectionEpoch: number;
}

interface SectionConsumer<TValue> {
  resolve(value: TValue): void;
  reject(reason: unknown): void;
  signal?: AbortSignal | undefined;
  onAbort?: () => void;
}

interface SectionFlight<TSection extends string, TValue> {
  readonly section: TSection;
  readonly scope: SelectionScope;
  readonly controller: AbortController;
  readonly consumers: Set<SectionConsumer<TValue>>;
  active: boolean;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function abortErrorFor(signal: AbortSignal): unknown {
  const reason = signal.reason;
  return reason && typeof reason === "object" && "name" in reason && reason.name === "AbortError"
    ? reason
    : createAbortError();
}

function sameScope(left: SelectionScope | undefined, right: SelectionScope): boolean {
  return left?.campaignId === right.campaignId && left.selectionEpoch === right.selectionEpoch;
}

export function createLegacySectionLoader<TSection extends string, TValue>(
  { loadSection: loadSectionOperation }: CreateLegacySectionLoaderOptions<TSection, TValue>
): LegacySectionLoader<TSection, TValue> {
  let selection: SelectionScope | undefined;
  const cache = new Map<TSection, TValue>();
  const flights = new Map<TSection, SectionFlight<TSection, TValue>>();

  const removeConsumer = (flight: SectionFlight<TSection, TValue>, consumer: SectionConsumer<TValue>) => {
    if (!flight.consumers.delete(consumer)) return;
    if (consumer.signal && consumer.onAbort) consumer.signal.removeEventListener("abort", consumer.onAbort);
  };

  const retireFlight = (flight: SectionFlight<TSection, TValue>) => {
    if (!flight.active) return;
    flight.active = false;
    if (flights.get(flight.section) === flight) flights.delete(flight.section);
    flight.controller.abort(createAbortError());
    for (const consumer of [...flight.consumers]) {
      removeConsumer(flight, consumer);
      consumer.reject(createAbortError());
    }
  };

  const startFlight = (section: TSection, scope: SelectionScope): SectionFlight<TSection, TValue> => {
    const flight: SectionFlight<TSection, TValue> = {
      section,
      scope,
      controller: new AbortController(),
      consumers: new Set(),
      active: true
    };
    flights.set(section, flight);

    let operation: Promise<TValue>;
    try {
      operation = Promise.resolve(loadSectionOperation({ ...scope, section, signal: flight.controller.signal }));
    } catch (error) {
      operation = Promise.reject(error);
    }

    void operation.then(
      (value) => {
        if (!flight.active || flights.get(section) !== flight || !sameScope(selection, flight.scope)) return;
        flight.active = false;
        flights.delete(section);
        cache.set(section, value);
        for (const consumer of [...flight.consumers]) {
          removeConsumer(flight, consumer);
          consumer.resolve(value);
        }
      },
      (error: unknown) => {
        if (!flight.active || flights.get(section) !== flight) return;
        flight.active = false;
        flights.delete(section);
        for (const consumer of [...flight.consumers]) {
          removeConsumer(flight, consumer);
          consumer.reject(error);
        }
      }
    );
    return flight;
  };

  return {
    setSelection(campaignId, selectionEpoch) {
      const nextSelection = { campaignId, selectionEpoch };
      if (sameScope(selection, nextSelection)) return;
      selection = nextSelection;
      cache.clear();
      for (const flight of [...flights.values()]) retireFlight(flight);
    },
    loadSection(section, signal) {
      if (!selection) return Promise.reject(new Error("A campaign selection must be set before loading a section."));
      if (signal?.aborted) return Promise.reject(abortErrorFor(signal));

      if (cache.has(section)) return Promise.resolve(cache.get(section) as TValue);

      const flight = flights.get(section) ?? startFlight(section, selection);
      return new Promise<TValue>((resolve, reject) => {
        const consumer: SectionConsumer<TValue> = { resolve, reject, signal };
        if (signal) {
          consumer.onAbort = () => {
            removeConsumer(flight, consumer);
            reject(abortErrorFor(signal));
            if (flight.consumers.size === 0) retireFlight(flight);
          };
          signal.addEventListener("abort", consumer.onAbort, { once: true });
        }
        flight.consumers.add(consumer);

        if (signal?.aborted) consumer.onAbort?.();
      });
    },
    invalidate(section) {
      cache.delete(section);
      const flight = flights.get(section);
      if (flight) retireFlight(flight);
    }
  };
}
