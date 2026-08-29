const MAX_AUDIO_IMPORT_FILE_BYTES = 512 * 1024 * 1024;
const MAX_AUDIO_IMPORT_SELECTION_FILES = 256;

const assertAudioImportSelectionCount = (count) => {
    if (!Number.isInteger(count) || count < 0 || count > MAX_AUDIO_IMPORT_SELECTION_FILES) {
        throw new Error(`Selecciona hasta ${MAX_AUDIO_IMPORT_SELECTION_FILES} pistas por importacion.`);
    }
};

const assertAudioImportFileSize = (name, size) => {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`No se pudo validar el tamano de ${name || 'la pista seleccionada'}.`);
    }
    if (size > MAX_AUDIO_IMPORT_FILE_BYTES) {
        throw new Error(`El archivo ${name || 'seleccionado'} supera el limite de 512 MB.`);
    }
};

module.exports = {
    MAX_AUDIO_IMPORT_FILE_BYTES,
    MAX_AUDIO_IMPORT_SELECTION_FILES,
    assertAudioImportFileSize,
    assertAudioImportSelectionCount
};
