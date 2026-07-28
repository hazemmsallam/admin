package com.eventticketing.admin.client.dto;

/** One seat inside a preset, positioned relative to the preset's bounding box. */
public record PresetSeatItem(
        int x,
        int y,
        int width,
        int height,
        int rotationDegrees,
        String sectionName,
        Integer rowOffset
) {
}
