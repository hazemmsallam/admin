package com.eventticketing.admin.client.dto;

import java.util.List;

/** One section inside a preset; {@code points} are relative to the preset's bounding box. */
public record PresetSectionItem(
        String name,
        String bookingMode,
        String currency,
        Integer capacity,
        String shapeKind,
        List<PointItem> points,
        String color
) {
}
