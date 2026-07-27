package com.eventticketing.admin.web.form;

import lombok.Data;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Pricing form. Modern halls price each section dynamically ({@link #sections}); halls without
 * sections fall back to the legacy per-seat-type / general-admission fields.
 */
@Data
public class PricingForm {

    /** One editable price row per hall section. */
    private List<SectionPriceRow> sections = new ArrayList<>();

    // Legacy fallback for halls that have no sections yet.
    private BigDecimal vipPrice;
    private BigDecimal premiumPrice;
    private BigDecimal regularPrice;
    private BigDecimal generalPrice;

    @Data
    public static class SectionPriceRow {
        private Long sectionId;
        private String name;
        private String bookingMode;
        private String currency;
        private BigDecimal price;
    }
}
