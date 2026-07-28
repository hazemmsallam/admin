package com.eventticketing.admin.client.dto;

/** One non-bookable layout object inside a preset, positioned relative to its bounding box. */
public record PresetTableItem(
        String objectType,
        String shape,
        String label,
        int x,
        int y,
        int z,
        int rotationDegrees,
        int width,
        int depth,
        int objectHeight
) {
}
