package com.eventticketing.admin.client.dto;

import java.time.Instant;

public record CreateEventRequest(
        String name,
        String description,
        String category,
        Instant startAt,
        Instant endAt,
        Long organizerId,
        Long hallId,
        Integer maxCapacity
) {
}
