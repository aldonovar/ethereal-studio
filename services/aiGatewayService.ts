import type { Note, Track } from '../types';

export const AI_GATEWAY_UNAVAILABLE = 'AI_GATEWAY_UNAVAILABLE' as const;

export interface GeneratedPattern {
  name?: string;
  notes: Note[];
}

export interface AiGatewayStatus {
  available: false;
  code: typeof AI_GATEWAY_UNAVAILABLE;
  message: string;
}

const unavailableStatus: AiGatewayStatus = Object.freeze({
  available: false,
  code: AI_GATEWAY_UNAVAILABLE,
  message: 'El asistente IA requiere el gateway seguro del servidor y no esta disponible en este build.'
});

export class AiGatewayError extends Error {
  readonly code = AI_GATEWAY_UNAVAILABLE;

  constructor() {
    super(unavailableStatus.message);
    this.name = 'AiGatewayError';
  }
}

export const isAiGatewayError = (error: unknown): error is AiGatewayError => (
  error instanceof AiGatewayError
  || (typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === AI_GATEWAY_UNAVAILABLE)
);

export const getAiGatewayStatus = (): AiGatewayStatus => unavailableStatus;

const rejectUntilServerGatewayExists = async <T>(): Promise<T> => {
  throw new AiGatewayError();
};

export const generatePattern = async (
  _prompt: string,
  _bpm: number
): Promise<GeneratedPattern> => rejectUntilServerGatewayExists();

export const analyzeMix = async (
  _tracks: Track[]
): Promise<string> => rejectUntilServerGatewayExists();
