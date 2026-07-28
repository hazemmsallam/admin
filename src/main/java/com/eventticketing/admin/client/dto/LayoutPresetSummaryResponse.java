package com.eventticketing.admin.client.dto;

import java.time.Instant;

/** A saved preset without its members — enough to render the picker list. */
public record LayoutPresetSummaryResponse(
        Long id,
        String name,
        String description,
        Integer width,
        Integer height,
        int sectionCount,
        int seatCount,
        int tableCount,
        Instant createdAt
) {
}
