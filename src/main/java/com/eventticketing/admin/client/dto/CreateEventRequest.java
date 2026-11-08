package com.eventticketing.admin.client.dto;

import java.time.Instant;
import java.util.Set;

public record CreateEventRequest(
        String name,
        String description,
        String category,
        String imageUrl,
        String tagline,
        Boolean featured,
        Set<String> tags,
        Instant startAt,
        Instant endAt,
        Long organizerId,
        Long hallId,
        Integer maxCapacity
) {
}
