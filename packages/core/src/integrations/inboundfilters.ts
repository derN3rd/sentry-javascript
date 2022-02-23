import { Event, EventProcessor, Hub, Integration, StackFrame } from '@sentry/types';
import { getEventDescription, isDebugBuild, isMatchingPattern, logger } from '@sentry/utils';

// "Script error." is hard coded into browsers for errors that it can't read.
// this is the result of a script being pulled in from an external domain and CORS.
const DEFAULT_IGNORE_ERRORS = [/^Script error\.?$/, /^Javascript error: Script error\.? on line 0$/];

/** JSDoc */
export interface InboundFiltersOptions {
  allowUrls: Array<string | RegExp>;
  denyUrls: Array<string | RegExp>;
  ignoreErrors: Array<string | RegExp>;
  ignoreInternal: boolean;

  /** @deprecated use {@link InboundFiltersOptions.allowUrls} instead. */
  whitelistUrls: Array<string | RegExp>;
  /** @deprecated use {@link InboundFiltersOptions.denyUrls} instead. */
  blacklistUrls: Array<string | RegExp>;
}

/** Inbound filters configurable by the user */
export class InboundFilters implements Integration {
  /**
   * @inheritDoc
   */
  public static id: string = 'InboundFilters';

  /**
   * @inheritDoc
   */
  public name: string = InboundFilters.id;

  public constructor(private readonly _options: Partial<InboundFiltersOptions> = {}) {}

  /**
   * @inheritDoc
   */
  public setupOnce(addGlobalEventProcessor: (callback: EventProcessor) => void, getCurrentHub: () => Hub): void {
    addGlobalEventProcessor((event: Event) => {
      const hub = getCurrentHub();
      if (hub) {
        const self = hub.getIntegration(InboundFilters);
        if (self) {
          const client = hub.getClient();
          const clientOptions = client ? client.getOptions() : {};
          const options = _mergeOptions(self._options, clientOptions);
          return _shouldDropEvent(event, options) ? null : event;
        }
      }
      return event;
    });
  }
}

/** JSDoc */
export function _mergeOptions(
  intOptions: Partial<InboundFiltersOptions> = {},
  clientOptions: Partial<InboundFiltersOptions> = {},
): Partial<InboundFiltersOptions> {
  return {
    allowUrls: [
      // eslint-disable-next-line deprecation/deprecation
      ...(intOptions.whitelistUrls || []),
      ...(intOptions.allowUrls || []),
      // eslint-disable-next-line deprecation/deprecation
      ...(clientOptions.whitelistUrls || []),
      ...(clientOptions.allowUrls || []),
    ],
    denyUrls: [
      // eslint-disable-next-line deprecation/deprecation
      ...(intOptions.blacklistUrls || []),
      ...(intOptions.denyUrls || []),
      // eslint-disable-next-line deprecation/deprecation
      ...(clientOptions.blacklistUrls || []),
      ...(clientOptions.denyUrls || []),
    ],
    ignoreErrors: [...(intOptions.ignoreErrors || []), ...(clientOptions.ignoreErrors || []), ...DEFAULT_IGNORE_ERRORS],
    ignoreInternal: typeof intOptions.ignoreInternal !== 'undefined' ? intOptions.ignoreInternal : true,
  };
}

/** JSDoc */
export function _shouldDropEvent(event: Event, options: Partial<InboundFiltersOptions>): boolean {
  if (_isSentryError(event, options.ignoreInternal)) {
    if (isDebugBuild()) {
      logger.warn(`Event dropped due to being internal Sentry Error.\nEvent: ${getEventDescription(event)}`);
    }
    return true;
  }
  if (_isIgnoredError(event, options.ignoreErrors)) {
    if (isDebugBuild()) {
      logger.warn(
        `Event dropped due to being matched by \`ignoreErrors\` option.\nEvent: ${getEventDescription(event)}`,
      );
    }
    return true;
  }
  if (_isDeniedUrl(event, options.denyUrls)) {
    if (isDebugBuild()) {
      logger.warn(
        `Event dropped due to being matched by \`denyUrls\` option.\nEvent: ${getEventDescription(
          event,
        )}.\nUrl: ${_getEventFilterUrl(event)}`,
      );
    }
    return true;
  }
  if (!_isAllowedUrl(event, options.allowUrls)) {
    if (isDebugBuild()) {
      logger.warn(
        `Event dropped due to not being matched by \`allowUrls\` option.\nEvent: ${getEventDescription(
          event,
        )}.\nUrl: ${_getEventFilterUrl(event)}`,
      );
    }
    return true;
  }
  return false;
}

/** JSDoc */
function _isIgnoredError(event: Event, ignoreErrors: Partial<InboundFiltersOptions>['ignoreErrors']): boolean {
  if (!ignoreErrors || !ignoreErrors.length) {
    return false;
  }

  return _getPossibleEventMessages(event).some(message =>
    ignoreErrors.some(pattern => isMatchingPattern(message, pattern)),
  );
}

/** JSDoc */
function _isDeniedUrl(event: Event, denyUrls: Partial<InboundFiltersOptions>['denyUrls']): boolean {
  // TODO: Use Glob instead?
  if (!denyUrls || !denyUrls.length) {
    return false;
  }
  const url = _getEventFilterUrl(event);
  return !url ? false : denyUrls.some(pattern => isMatchingPattern(url, pattern));
}

/** JSDoc */
function _isAllowedUrl(event: Event, allowUrls: Partial<InboundFiltersOptions>['allowUrls']): boolean {
  // TODO: Use Glob instead?
  if (!allowUrls || !allowUrls.length) {
    return true;
  }
  const url = _getEventFilterUrl(event);
  return !url ? true : allowUrls.some(pattern => isMatchingPattern(url, pattern));
}

/** JSDoc */
function _getPossibleEventMessages(event: Event): string[] {
  if (event.message) {
    return [event.message];
  }
  if (event.exception) {
    try {
      const { type = '', value = '' } = (event.exception.values && event.exception.values[0]) || {};
      return [`${value}`, `${type}: ${value}`];
    } catch (oO) {
      if (isDebugBuild()) {
        logger.error(`Cannot extract message for event ${getEventDescription(event)}`);
      }
      return [];
    }
  }
  return [];
}

/** JSDoc */
function _isSentryError(event: Event, ignoreInternal: Partial<InboundFiltersOptions>['ignoreInternal']): boolean {
  if (ignoreInternal) {
    try {
      // @ts-ignore can't be a sentry error if undefined
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return event.exception.values[0].type === 'SentryError';
    } catch (e) {
      // ignore
    }
  }
  return false;
}

/** JSDoc */
function _getLastValidUrl(frames: StackFrame[] = []): string | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];

    if (frame && frame.filename !== '<anonymous>' && frame.filename !== '[native code]') {
      return frame.filename || null;
    }
  }

  return null;
}

/** JSDoc */
function _getEventFilterUrl(event: Event): string | null {
  try {
    if (event.stacktrace) {
      return _getLastValidUrl(event.stacktrace.frames);
    }
    let frames;
    try {
      // @ts-ignore we only care about frames if the whole thing here is defined
      frames = event.exception.values[0].stacktrace.frames;
    } catch (e) {
      // ignore
    }
    return frames ? _getLastValidUrl(frames) : null;
  } catch (oO) {
    if (isDebugBuild()) {
      logger.error(`Cannot extract url for event ${getEventDescription(event)}`);
    }
    return null;
  }
}
