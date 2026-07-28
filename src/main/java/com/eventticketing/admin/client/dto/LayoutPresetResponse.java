package com.eventticketing.admin.client.dto;

import java.time.Instant;

/** A saved preset with its full contents — what the editor needs to stamp it onto a hall. */
public record LayoutPresetResponse(
        Long id,
        String name,
        String description,
        Integer width,
        Integer height,
        PresetMembers members,
        Instant createdAt
) {
}
