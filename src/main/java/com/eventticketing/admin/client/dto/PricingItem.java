package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;

/** A price line: {@code sectionId} keys section pricing; {@code seatType} is the legacy fallback. */
public record PricingItem(String seatType, Long sectionId, BigDecimal price) {
}
