import { describe, expect, it } from 'vitest';

import {
    AI_GATEWAY_UNAVAILABLE,
    AiGatewayError,
    analyzeMix,
    generatePattern,
    getAiGatewayStatus,
    isAiGatewayError
} from '../../services/aiGatewayService';

describe('aiGatewayService secure recovery boundary', () => {
    it('reports an explicit unavailable state without requiring an account or network', () => {
        expect(getAiGatewayStatus()).toEqual({
            available: false,
            code: AI_GATEWAY_UNAVAILABLE,
            message: expect.stringContaining('gateway seguro del servidor')
        });
    });

    it('rejects pattern generation until the server-only gateway exists', async () => {
        await expect(generatePattern('private prompt', 120)).rejects.toMatchObject({
            code: AI_GATEWAY_UNAVAILABLE
        });
    });

    it('rejects mix analysis without serializing track data in the renderer', async () => {
        await expect(analyzeMix([])).rejects.toMatchObject({
            code: AI_GATEWAY_UNAVAILABLE
        });
    });

    it('recognizes typed gateway errors', () => {
        expect(isAiGatewayError(new AiGatewayError())).toBe(true);
        expect(isAiGatewayError(new Error('other'))).toBe(false);
    });
});
