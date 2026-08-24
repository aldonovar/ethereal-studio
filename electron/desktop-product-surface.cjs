const DESKTOP_PRODUCT_IDS = Object.freeze(['studio', 'score', 'keys']);
const DESKTOP_PRODUCT_SET = new Set(DESKTOP_PRODUCT_IDS);

class DesktopProductSurfaceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DesktopProductSurfaceError';
        this.code = 'INVALID_DESKTOP_PRODUCT';
    }
}

const normalizeOptionalIdentifier = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 256 || value.trim() !== value) {
        throw new DesktopProductSurfaceError(`${label} no es válido.`);
    }
    return value;
};

const normalizeDesktopProduct = (value) => {
    const product = value === undefined || value === null || value === '' ? 'studio' : value;
    if (typeof product !== 'string' || !DESKTOP_PRODUCT_SET.has(product)) {
        throw new DesktopProductSurfaceError('La superficie solicitada no está autorizada.');
    }
    return product;
};

const normalizeDesktopEditorRequest = (request) => {
    if (request === undefined || request === null) {
        return { product: 'studio' };
    }
    if (typeof request !== 'object' || Array.isArray(request)) {
        throw new DesktopProductSurfaceError('La solicitud del editor no es válida.');
    }

    return {
        product: normalizeDesktopProduct(request.product),
        projectId: normalizeOptionalIdentifier(request.projectId, 'El proyecto'),
        shareToken: normalizeOptionalIdentifier(request.shareToken, 'El token compartido'),
    };
};

const getDesktopProductTitle = (product) => ({
    studio: 'DAW-fi Studio',
    score: 'Score-fi',
    keys: 'Keys-fi',
})[normalizeDesktopProduct(product)];

module.exports = {
    DESKTOP_PRODUCT_IDS,
    DesktopProductSurfaceError,
    getDesktopProductTitle,
    normalizeDesktopEditorRequest,
    normalizeDesktopProduct,
};
