package com.eventticketing.admin.client.dto;

import java.time.Instant;

public record EventSummaryResponse(
        Long id,
        String name,
        String category,
        Instant startAt,
        Instant endAt,
        String status,
        Long hallId,
        String hallName,
        boolean seated
) {
}
