package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;

/** A price override for one hall section. */
public record PricingItem(Long sectionId, BigDecimal price) {
}
